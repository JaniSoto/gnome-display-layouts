import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
    <method name="Apply">
      <arg type="s" name="name" direction="in"/>
    </method>
    <method name="Toggle">
      <arg type="as" name="aliases" direction="in"/>
      <arg type="as" name="toggles" direction="out"/>
    </method>
    <method name="Save">
      <arg type="s" name="name" direction="in"/>
    </method>
  </interface>
</node>`;

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
        } catch (e) {
            throw new Error(e.message);
        }
    }

    async Toggle(aliases) {
        try {
            let toggles = await LayoutEngine.toggleLayouts(aliases);
            if (this._rebuildCallback) await this._rebuildCallback();
            return toggles;
        } catch (e) {
            throw new Error(e.message);
        }
    }

    async Save(name) {
        try {
            let resolver = async (connector, vendor, product, x, y, defaultAlias) => {
                return connector || defaultAlias;
            };
            await LayoutEngine.saveLayout(name, resolver);
            if (this._rebuildCallback) await this._rebuildCallback();
        } catch (e) {
            throw new Error(e.message);
        }
    }
}

const LayoutIndicator = GObject.registerClass({
    GTypeName: 'DisplayLayoutsIndicator',
}, class LayoutIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Display Layouts');

        this._displayStateCache = null;

        this._icon = new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._openStateId = this.menu.connect('open-state-changed', async (menu, open) => {
            if (open) {
                await this._refreshAndRebuild();
            }
        });

        this._initDisplayTracking();
    }

    async _initDisplayTracking() {
        try {
            this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
        } catch (e) {
            console.error(`[Display Layouts] Initial cache load failed: ${e}`);
        }

        try {
            this._signalId = Gio.DBus.session.signal_subscribe(
                'org.gnome.Mutter.DisplayConfig',
                'org.gnome.Mutter.DisplayConfig',
                'MonitorsChanged',
                '/org/gnome/Mutter/DisplayConfig',
                null,
                Gio.DBusSignalFlags.NONE,
                async () => {
                    try {
                        this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                        await this._refreshAndRebuild();
                    } catch (err) {
                        console.error(`[Display Layouts] Cache update failed on event: ${err}`);
                    }
                }
            );
        } catch (e) {
            console.error(`[Display Layouts] Signal subscription failed: ${e}`);
        }

        await this._refreshAndRebuild();
    }

    async _refreshAndRebuild() {
        try {
            let activeProfile = '';
            let activeFileContent = await LayoutEngine.readTextFileAsync(LayoutEngine.ACTIVE_PROFILE_FILE);
            if (activeFileContent) {
                activeProfile = activeFileContent.trim();
            }

            let profiles = await LayoutEngine.getProfilesAsync();

            let activeJsonStr = null;
            if (activeProfile) {
                activeJsonStr = await LayoutEngine.readTextFileAsync(`${LayoutEngine.CONFIG_DIR}/${activeProfile}.json`);
            }

            this._rebuildMenuFromData(activeProfile, profiles, activeJsonStr);
        } catch (e) {
            console.error(`[Display Layouts] Rebuild background sequence failed: ${e}`);
        }
    }

    _rebuildMenuFromData(activeProfile, profiles, activeJsonStr) {
        this.menu.removeAll();

        // 1. Add Saved Profiles Section
        let titleItem = new PopupMenu.PopupMenuItem('Saved Profiles', { reactive: false });
        titleItem.label.style = 'font-weight: bold; color: #888;';
        this.menu.addMenuItem(titleItem);

        if (profiles.length === 0) {
            let emptyItem = new PopupMenu.PopupMenuItem('No profiles found');
            emptyItem.sensitive = false;
            this.menu.addMenuItem(emptyItem);
        } else {
            profiles.forEach(profile => {
                let isActive = (profile === activeProfile);
                let item = new PopupMenu.PopupMenuItem(profile);
                
                if (isActive) {
                    item.setOrnament(PopupMenu.Ornament.CHECK);
                }

                item.connect('activate', async () => {
                    try {
                        await LayoutEngine.applyLayout(profile);
                        Main.notify('Display Layouts', `Applied layout: ${profile}`);
                        this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                        await this._refreshAndRebuild();
                    } catch (err) {
                        Main.notify('Display Layouts', `Error: ${err.message}`);
                    }
                });
                this.menu.addMenuItem(item);
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 2. Toggle Section for Active Profile Aliases (Synchronous from Cache)
        if (activeProfile && this._displayStateCache && activeJsonStr) {
            try {
                let profileData = JSON.parse(activeJsonStr);
                let labels = profileData.labels || {};
                let aliases = Object.keys(labels);

                    if (aliases.length > 0) {
                        let toggleHeader = new PopupMenu.PopupMenuItem('Toggle Displays', { reactive: false });
                        toggleHeader.label.style = 'font-weight: bold; color: #888;';
                        this.menu.addMenuItem(toggleHeader);

                        let [serial, phys, logical, props] = this._displayStateCache;

                        let activeHwSigs = new Set();
                        for (let lm of logical) {
                            for (let p of lm[5]) {
                                activeHwSigs.add(LayoutEngine.getHwSig(p));
                            }
                        }

                        aliases.forEach(alias => {
                            let item = new PopupMenu.PopupMenuItem(alias);
                            let targetHwSig = labels[alias];
                            let isOn = activeHwSigs.has(targetHwSig);

                            if (isOn) {
                                item.setOrnament(PopupMenu.Ornament.CHECK);
                            }

                            item.connect('activate', async () => {
                                try {
                                    let toggles = await LayoutEngine.toggleLayouts([alias]);
                                    Main.notify('Display Layouts', `Toggled: ${toggles.join(', ')}`);
                                    this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                                    await this._refreshAndRebuild();
                                } catch (err) {
                                    Main.notify('Display Layouts', `Error: ${err.message}`);
                                }
                            });
                            this.menu.addMenuItem(item);
                        });

                        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    }
            } catch (e) {
                console.error(`[Display Layouts] Failed to build toggles: ${e}`);
            }
        }

        // 3. Save Current State Button
        let saveItem = new PopupMenu.PopupMenuItem('Save Current Layout...');
        saveItem.connect('activate', () => {
            this.triggerSaveDialog();
        });
        this.menu.addMenuItem(saveItem);
    }

    triggerSaveDialog() {
        if (!this._displayStateCache) {
            Main.notify('Display Layouts', 'Error: No active display state cached.');
            return;
        }

        let monitorsToLabel = [];
        let [serial, phys, logical, props] = this._displayStateCache;
        for (let idx = 0; idx < logical.length; idx++) {
            let lm = logical[idx];
            let [x, y, scale, transform, primary, physList] = lm;
            for (let p of physList) {
                monitorsToLabel.push({
                    connector: p[0],
                    manufacturer: p[1],
                    modelName: p[2],
                    x,
                    y,
                    defaultAlias: String(idx + 1)
                });
            }
        }

        let dialog = new SaveLayoutDialog(monitorsToLabel, async (name, aliasMap) => {
            try {
                let resolver = async (connector, vendor, product, x, y, defaultAlias) => {
                    return aliasMap[connector] || defaultAlias;
                };
                await LayoutEngine.saveLayout(name, resolver);
                Main.notify('Display Layouts', `Saved layout '${name}' successfully.`);
                this._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                await this._refreshAndRebuild();
            } catch (err) {
                Main.notify('Display Layouts', `Failed to save: ${err.message}`);
            }
        });
        dialog.open();
    }

    destroy() {
        if (this._signalId) {
            Gio.DBus.session.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = null;
        }
        super.destroy();
    }
});

export default class DisplayLayoutsExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.display-layouts');
        this._indicator = null;

        // DBus callback service
        this._dbusService = new DisplayLayoutsDBusService(async () => {
            if (this._indicator) {
                try {
                    this._indicator._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                    await this._indicator._refreshAndRebuild();
                } catch (e) {
                    console.error(`[Display Layouts] External cache refresh failed: ${e}`);
                }
            }
        });

        // Initialize 8 generic hotkey controllers
        this._bindings = [];
        for (let i = 1; i <= 8; i++) {
            this._bindings.push({
                index: i,
                shortcutKey: `shortcut-${i}`,
                targetKey: `target-${i}`,
                actionKey: `action-${i}`
            });
        }

        this._bindings.forEach(b => {
            Main.wm.addKeybinding(
                b.shortcutKey,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                async () => {
                    let action = this._settings.get_string(b.actionKey);
                    let target = this._settings.get_string(b.targetKey).trim();

                    try {
                        if (action === 'apply') {
                            if (!target) return;
                            await LayoutEngine.applyLayout(target);
                            Main.notify('Display Layouts', `Applied layout: ${target}`);
                        } else if (action === 'toggle') {
                            if (!target) return;
                            let toggles = await LayoutEngine.toggleLayouts([target]);
                            Main.notify('Display Layouts', `Toggled: ${toggles.join(', ')}`);
                        } else if (action === 'save') {
                            if (this._indicator) {
                                this._indicator.triggerSaveDialog();
                            }
                        }

                        // Update current UI components
                        if (this._indicator) {
                            this._indicator._displayStateCache = await LayoutEngine.getCurrentDisplayStateAsync();
                            await this._indicator._refreshAndRebuild();
                        }
                    } catch (e) {
                        Main.notify('Display Layouts', `Error: ${e.message}`);
                    }
                }
            );
        });

        // Watch panel icon toggling setting
        this._settingsId = this._settings.connect('changed::show-indicator', () => {
            this._updateIndicatorVisibility();
        });

        this._updateIndicatorVisibility();
    }

    _updateIndicatorVisibility() {
        let show = this._settings.get_boolean('show-indicator');
        if (show) {
            if (!this._indicator) {
                this._indicator = new LayoutIndicator();
                Main.panel.addToStatusArea(this.uuid, this._indicator);
            }
        } else {
            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
        }
    }

    disable() {
        if (this._bindings) {
            this._bindings.forEach(b => {
                Main.wm.removeKeybinding(b.shortcutKey);
            });
            this._bindings = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._dbusService) {
            this._dbusService.destroy();
            this._dbusService = null;
        }
        this._settings = null;
    }
}
