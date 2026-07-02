import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as LayoutEngine from './layoutEngine.js';
import { SaveLayoutDialog } from './dialogs.js';

const DBUS_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.DisplayLayouts">
    <method name="Apply"><arg type="s" name="name" direction="in"/></method>
    <method name="Toggle"><arg type="as" name="aliases" direction="in"/><arg type="as" name="toggles" direction="out"/></method>
    <method name="Save"><arg type="s" name="name" direction="in"/></method>
  </interface>
</node>`;

function _logError(error, context) {
    console.error(`[Display Layouts] ${context}: ${error.message || error}`);
}

class DisplayLayoutsDBusService {
    constructor(rebuildCallback) {
        this._rebuildCallback = rebuildCallback;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/DisplayLayouts');
    }

    destroy() {
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    async Apply(name) {
        try {
            await LayoutEngine.applyLayout(name);
            if (this._rebuildCallback) await this._rebuildCallback();
        } catch (e) { throw new Error(e.message); }
    }

    async Toggle(aliases) {
        try {
            let toggles = await LayoutEngine.toggleLayouts(aliases);
            if (this._rebuildCallback) await this._rebuildCallback();
            return toggles;
        } catch (e) { throw new Error(e.message); }
    }

    async Save(name) {
        try {
            let resolver = async (conn, v, p, x, y, def) => conn || def;
            await LayoutEngine.saveLayout(name, resolver);
            if (this._rebuildCallback) await this._rebuildCallback();
        } catch (e) { throw new Error(e.message); }
    }
}

const LayoutIndicator = GObject.registerClass({
    GTypeName: 'DisplayLayoutsIndicator',
}, class LayoutIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Display Layouts');
        this._displayStateCache = null;

        this._icon = new St.Icon({ icon_name: 'video-display-symbolic', style_class: 'system-status-icon' });
        this.add_child(this._icon);

        this._openStateId = this.menu.connect('open-state-changed', async (menu, open) => {
            if (open) await this._refreshAndRebuild();
        });

        this._initDisplayTracking();
    }

    async _initDisplayTracking() {
        try {
            this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
        } catch (e) { _logError(e, 'Initial cache load failed'); }

        try {
            this._signalId = Gio.DBus.session.signal_subscribe(
                'org.gnome.Mutter.DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged',
                '/org/gnome/Mutter/DisplayConfig', null, Gio.DBusSignalFlags.NONE,
                async () => {
                    try {
                        this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                        await this._refreshAndRebuild();
                    } catch (err) { _logError(err, 'Cache update failed on event'); }
                }
            );
        } catch (e) { _logError(e, 'Signal subscription failed'); }

        await this._refreshAndRebuild();
    }

    async _refreshAndRebuild() {
        try {
            let activeProfile = (await LayoutEngine.readTextFileAsync(LayoutEngine.ACTIVE_PROFILE_FILE))?.trim() || '';
            let profiles = await LayoutEngine.getProfilesAsync();
            let activeJsonStr = activeProfile ? await LayoutEngine.readTextFileAsync(`${LayoutEngine.CONFIG_DIR}/${activeProfile}.json`) : null;

            this._rebuildMenuFromData(activeProfile, profiles, activeJsonStr);
        } catch (e) { _logError(e, 'Rebuild background sequence failed'); }
    }

    _rebuildMenuFromData(activeProfile, profiles, activeJsonStr) {
        this.menu.removeAll();

        // Saved Profiles Section
        let titleItem = new PopupMenu.PopupMenuItem('Saved Profiles', { reactive: false });
        titleItem.label.style = 'font-weight: bold; color: #888;';
        this.menu.addMenuItem(titleItem);

        if (profiles.length === 0) {
            let emptyItem = new PopupMenu.PopupMenuItem('No profiles found');
            emptyItem.sensitive = false;
            this.menu.addMenuItem(emptyItem);
        } else {
            profiles.forEach(profile => {
                let item = new PopupMenu.PopupMenuItem(profile);
                if (profile === activeProfile) item.setOrnament(PopupMenu.Ornament.CHECK);

                item.connect('activate', async () => {
                    try {
                        await LayoutEngine.applyLayout(profile);
                        Main.notify('Display Layouts', `Applied layout: ${profile}`);
                        this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                        await this._refreshAndRebuild();
                    } catch (err) { Main.notify('Display Layouts', `Error: ${err.message}`); }
                });
                this.menu.addMenuItem(item);
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Dynamic Toggle Section
        if (activeProfile && this._displayStateCache && activeJsonStr) {
            try {
                let profileData = JSON.parse(activeJsonStr);
                let labels = profileData.labels || {};
                let aliases = Object.keys(labels);

                if (aliases.length > 0) {
                    let toggleHeader = new PopupMenu.PopupMenuItem('Toggle Displays', { reactive: false });
                    toggleHeader.label.style = 'font-weight: bold; color: #888;';
                    this.menu.addMenuItem(toggleHeader);

                    let activeHwSigs = new Set(this._displayStateCache[2].flatMap(lm => lm[5].map(LayoutEngine.getHwSig)));

                    aliases.forEach(alias => {
                        let item = new PopupMenu.PopupMenuItem(alias);
                        if (activeHwSigs.has(labels[alias])) item.setOrnament(PopupMenu.Ornament.CHECK);

                        item.connect('activate', async () => {
                            try {
                                let toggles = await LayoutEngine.toggleLayouts([alias]);
                                Main.notify('Display Layouts', `Toggled: ${toggles.join(', ')}`);
                                this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                                await this._refreshAndRebuild();
                            } catch (err) { Main.notify('Display Layouts', `Error: ${err.message}`); }
                        });
                        this.menu.addMenuItem(item);
                    });
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                }
            } catch (e) { _logError(e, 'Failed to build toggles'); }
        }

        let saveItem = new PopupMenu.PopupMenuItem('Save Current Layout...');
        saveItem.connect('activate', () => this.triggerSaveDialog());
        this.menu.addMenuItem(saveItem);
    }

    triggerSaveDialog() {
        if (!this._displayStateCache) return Main.notify('Display Layouts', 'Error: No active display state cached.');

        let monitorsToLabel = this._displayStateCache[2].flatMap((lm, idx) => 
            lm[5].map(p => ({ connector: p[0], manufacturer: p[1], modelName: p[2], x: lm[0], y: lm[1], defaultAlias: String(idx + 1) }))
        );

        new SaveLayoutDialog(monitorsToLabel, async (name, aliasMap) => {
            try {
                await LayoutEngine.saveLayout(name, async (conn, v, p, x, y, def) => aliasMap[conn] || def);
                Main.notify('Display Layouts', `Saved layout '${name}'.`);
                this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                await this._refreshAndRebuild();
            } catch (err) { Main.notify('Display Layouts', `Failed to save: ${err.message}`); }
        }).open();
    }

    destroy() {
        if (this._signalId) { Gio.DBus.session.signal_unsubscribe(this._signalId); this._signalId = null; }
        if (this._openStateId) { this.menu.disconnect(this._openStateId); this._openStateId = null; }
        super.destroy();
    }
});

export default class DisplayLayoutsExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.display-layouts');
        this._indicator = null;

        this._dbusService = new DisplayLayoutsDBusService(async () => {
            if (this._indicator) {
                try {
                    this._indicator._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                    await this._indicator._refreshAndRebuild();
                } catch (e) { _logError(e, 'External cache refresh failed'); }
            }
        });

        this._bindings = Array.from({ length: 8 }, (_, i) => ({
            shortcutKey: `shortcut-${i+1}`, targetKey: `target-${i+1}`, actionKey: `action-${i+1}`
        }));

        this._bindings.forEach(b => {
            Main.wm.addKeybinding(b.shortcutKey, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, async () => {
                let action = this._settings.get_string(b.actionKey);
                let target = this._settings.get_string(b.targetKey).trim();

                try {
                    if (action === 'apply' && target) {
                        await LayoutEngine.applyLayout(target);
                        Main.notify('Display Layouts', `Applied layout: ${target}`);
                    } else if (action === 'toggle' && target) {
                        Main.notify('Display Layouts', `Toggled: ${(await LayoutEngine.toggleLayouts([target])).join(', ')}`);
                    } else if (action === 'save' && this._indicator) {
                        this._indicator.triggerSaveDialog();
                    }
                    if (this._indicator) {
                        this._indicator._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                        await this._indicator._refreshAndRebuild();
                    }
                } catch (e) { Main.notify('Display Layouts', `Error: ${e.message}`); }
            });
        });

        this._settingsId = this._settings.connect('changed::show-indicator', () => this._updateIndicatorVisibility());
        this._updateIndicatorVisibility();
    }

    _updateIndicatorVisibility() {
        let show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new LayoutIndicator();
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    disable() {
        if (this._bindings) { this._bindings.forEach(b => Main.wm.removeKeybinding(b.shortcutKey)); this._bindings = null; }
        if (this._settingsId) { this._settings.disconnect(this._settingsId); this._settingsId = null; }
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        if (this._dbusService) { this._dbusService.destroy(); this._dbusService = null; }
        this._settings = null;
    }
}
