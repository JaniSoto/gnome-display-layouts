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

// Module-level private GSettings reference
let _settings = null;

function _logError(error, context) {
    console.error(`[Display Layouts] ${context}: ${error.message || error}`);
}

function _notify(message, isError = false) {
    if (isError || (_settings && _settings.get_boolean('show-notifications'))) {
        Main.notify('Display Layouts', message);
    }
}

class DisplayLayoutsDBusService {
    constructor() {
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
        } catch (e) { throw new Error(e.message); }
    }

    async Toggle(aliases) {
        try {
            return await LayoutEngine.toggleLayouts(aliases);
        } catch (e) { throw new Error(e.message); }
    }

    async Save(name) {
        try {
            await LayoutEngine.saveLayout(name, async (conn, v, p, x, y, def) => conn || def);
        } catch (e) { throw new Error(e.message); }
    }
}

const LayoutIndicator = GObject.registerClass({
    GTypeName: 'DisplayLayoutsIndicator',
}, class LayoutIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Display Layouts');
        this._displayStateCache = null;
        this._destroyed = false;
        this._saveDialog = null;
        this._rebuildEpoch = 0;

        this._icon = new St.Icon({ icon_name: 'video-display-symbolic', style_class: 'system-status-icon' });
        this.add_child(this._icon);

        this.menu.connectObject('open-state-changed', async (menu, open) => {
            if (open) await this.updateCacheAndRebuild(true);
        }, this);

        this._initDisplayTracking();
    }

    async _initDisplayTracking() {
        await this.updateCacheAndRebuild(false);
    }

    async updateCacheAndRebuild(fromCache = false) {
        this._rebuildEpoch = (this._rebuildEpoch || 0) + 1;
        let epoch = this._rebuildEpoch;

        try {
            let queryRequired = !fromCache || !this._displayStateCache;

            if (queryRequired) {
                let state = await LayoutEngine.getCurrentDisplayStateAsync();
                if (this._destroyed || epoch !== this._rebuildEpoch) return;
                this._displayStateCache = state;
            }

            await this._refreshAndRebuild(epoch);
        } catch (e) { _logError(e, 'Cache update failed'); }
    }

    async _refreshAndRebuild(epoch) {
        if (this._destroyed || epoch !== this._rebuildEpoch) return;
        try {
            let activeProfile = (await LayoutEngine.readTextFileAsync(LayoutEngine.ACTIVE_PROFILE_FILE))?.trim() || '';
            if (this._destroyed || epoch !== this._rebuildEpoch) return;
            let profiles = await LayoutEngine.getProfilesAsync();
            if (this._destroyed || epoch !== this._rebuildEpoch) return;
            let activeJsonStr = activeProfile ? await LayoutEngine.readTextFileAsync(`${LayoutEngine.CONFIG_DIR}/${activeProfile}.json`) : null;

            if (this._destroyed || epoch !== this._rebuildEpoch) return;
            this._rebuildMenuFromData(activeProfile, profiles, activeJsonStr);
        } catch (e) { _logError(e, 'Rebuild background sequence failed'); }
    }

    _addSectionHeader(text) {
        let item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.style = 'font-weight: bold; color: #888;';
        this.menu.addMenuItem(item);
    }

    _rebuildMenuFromData(activeProfile, profiles, activeJsonStr) {
        if (this._destroyed) return;
        this.menu.removeAll();

        // Saved Profiles Section
        this._addSectionHeader('Saved Profiles');

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
                        if (this._destroyed) return;
                        _notify(`Applied layout: ${profile}`);
                    } catch (err) { _notify(`Error: ${err.message}`, true); }
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
                    this._addSectionHeader('Toggle Displays');

                    let [, , logicalMonitors] = this._displayStateCache;
                    let connToHw = LayoutEngine.buildConnToHwMap(this._displayStateCache[1]);
                    let activeHwSigs = new Set(logicalMonitors.flatMap(lm => lm[5].map(p => connToHw[p[0]])));

                    aliases.forEach(alias => {
                        let item = new PopupMenu.PopupMenuItem(alias);
                        if (activeHwSigs.has(labels[alias])) item.setOrnament(PopupMenu.Ornament.CHECK);

                        item.connect('activate', async () => {
                            try {
                                let toggles = await LayoutEngine.toggleLayouts([alias]);
                                if (this._destroyed) return;
                                _notify(`Toggled: ${toggles.join(', ')}`);
                            } catch (err) { _notify(`Error: ${err.message}`, true); }
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
        if (this._destroyed) return;
        if (!this._displayStateCache) return _notify('Error: No active display state cached.', true);

        // Close any pre-existing dialog to prevent leaks
        if (this._saveDialog) {
            this._saveDialog.close();
        }

        let [, , logicalMonitors] = this._displayStateCache;
        let monitorsToLabel = logicalMonitors.flatMap((lm, idx) =>
            lm[5].map(p => ({ connector: p[0], manufacturer: p[1], modelName: p[2], x: lm[0], y: lm[1], defaultAlias: String(idx + 1) }))
        );

        this._saveDialog = new SaveLayoutDialog(monitorsToLabel, async (name, aliasMap) => {
            try {
                await LayoutEngine.saveLayout(name, async (conn, v, p, x, y, def) => aliasMap[conn] || def);
                if (this._destroyed) return;
                _notify(`Saved layout '${name}'.`);
                await this.updateCacheAndRebuild(true);
            } catch (err) { _notify(`Failed to save: ${err.message}`, true); }
        });

        // Clear the reference cleanly upon destruction to avoid double-teardown runtime crashes
        this._saveDialog.connect('destroy', () => {
            this._saveDialog = null;
        });

        this._saveDialog.open();
    }

    destroy() {
        this._destroyed = true;
        if (this._saveDialog) {
            this._saveDialog.close();
            this._saveDialog = null;
        }
        this.menu.disconnectObject(this);
        super.destroy();
    }
});

export default class DisplayLayoutsExtension extends Extension {
    enable() {
        _settings = this.getSettings();
        this._indicator = null;
        this._cacheInitialized = false;
        this._lastConnectedHwSigs = null;

        this._initAutoApplyCache();

        this._dbusService = new DisplayLayoutsDBusService();

        this._bindings = Array.from({ length: 8 }, (_, i) => ({
            shortcutKey: `shortcut-${i+1}`, targetKey: `target-${i+1}`, actionKey: `action-${i+1}`
        }));

        this._bindings.forEach(b => {
            Main.wm.addKeybinding(b.shortcutKey, _settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, async () => {
                let action = _settings.get_string(b.actionKey);
                let target = _settings.get_string(b.targetKey).trim();

                try {
                    if (action === 'apply' && target) {
                        await LayoutEngine.applyLayout(target);
                        _notify(`Applied layout: ${target}`);
                    } else if (action === 'toggle' && target) {
                        let toggles = await LayoutEngine.toggleLayouts([target]);
                        _notify(`Toggled: ${toggles.join(', ')}`);
                    } else if (action === 'save' && this._indicator) {
                        this._indicator.triggerSaveDialog();
                    }
                } catch (e) { _notify(`Error: ${e.message}`, true); }
            });
        });

        this._signalId = Gio.DBus.session.signal_subscribe(
            'org.gnome.Mutter.DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged',
            '/org/gnome/Mutter/DisplayConfig', null, Gio.DBusSignalFlags.NONE,
            async () => {
                if (!this._cacheInitialized) return;

                // 1. Process matching engine
                let applied = await this._handleAutoApply();

                // 2. Cascade visual refresh ONLY if no layout was applied
                if (!applied && this._indicator) {
                    try {
                        await this._indicator.updateCacheAndRebuild(false);
                    } catch (err) { _logError(err, 'Centralized cache update failed'); }
                }
            }
        );

        _settings.connectObject('changed::show-indicator', () => this._updateIndicatorVisibility(), this);
        this._updateIndicatorVisibility();
    }

    async _initAutoApplyCache() {
        try {
            let [, phys] = await LayoutEngine.getCurrentDisplayStateAsync();
            this._lastConnectedHwSigs = phys.map(p => LayoutEngine.getHwSig(p[0])).sort().join(',');
            this._cacheInitialized = true;
        } catch (e) {
            _logError(e, 'Failed to initialize hardware signature cache');
        }
    }

    async _handleAutoApply() {
        try {
            let [, phys] = await LayoutEngine.getCurrentDisplayStateAsync();
            let currentHwSet = phys.map(p => LayoutEngine.getHwSig(p[0])).sort().join(',');

            // Prevent infinite layout-apply event loops
            if (currentHwSet === this._lastConnectedHwSigs) return false;
            this._lastConnectedHwSigs = currentHwSet;

            // Respect user opt-out configuration
            if (!_settings || !_settings.get_boolean('enable-auto-apply')) return false;

            // Increment run epoch to cancel stale, concurrent async actions
            this._latestAutoApplyId = (this._latestAutoApplyId || 0) + 1;
            let runId = this._latestAutoApplyId;

            let profiles = await LayoutEngine.getProfilesAsync();
            if (runId !== this._latestAutoApplyId) return false;

            for (let name of profiles) {
                let content = await LayoutEngine.readTextFileAsync(`${LayoutEngine.CONFIG_DIR}/${name}.json`);
                if (runId !== this._latestAutoApplyId) return false;
                if (!content) continue;

                let profile;
                try {
                    profile = JSON.parse(content);
                } catch (err) {
                    continue; // Isolated recovery: safely skip corrupted profile files
                }

                let profileHwSet = profile.logical_monitors.flatMap(lm => lm.monitors.map(m => m.hw_sig)).sort().join(',');

                if (profileHwSet === currentHwSet) {
                    await LayoutEngine.applyLayout(name);
                    _notify(`Auto-applied profile: ${name}`);
                    return true;
                }
            }
        } catch (e) {
            _logError(e, 'Auto-apply sequence failed');
        }
        return false;
    }

    _updateIndicatorVisibility() {
        let show = _settings.get_boolean('show-indicator');
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
        if (this._signalId) { Gio.DBus.session.signal_unsubscribe(this._signalId); this._signalId = null; }
        _settings?.disconnectObject(this);
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        if (this._dbusService) { this._dbusService.destroy(); this._dbusService = null; }
        _settings = null;
    }
}
