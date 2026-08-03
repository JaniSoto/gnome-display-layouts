// extension.js
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
    <method name="Cycle"><arg type="s" name="nextProfile" direction="out"/></method>
  </interface>
</node>`;

let _settings = null;

function _logError(error, context) {
    console.error(`[Display Layouts] ${context}: ${error.message || error}`);
}

function _notify(message, isError = false) {
    if (isError || (_settings && _settings.get_boolean('show-notifications'))) {
        Main.notify('Display Layouts', message);
    }
}

async function _callSafe(fn) {
    try {
        return await fn();
    } catch (e) {
        throw new Error(e.message);
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
        return _callSafe(() => LayoutEngine.applyLayout(name));
    }

    async Toggle(aliases) {
        return _callSafe(() => LayoutEngine.toggleLayouts(aliases));
    }

    async Save(name) {
        return _callSafe(() => LayoutEngine.saveLayout(name, async (conn, v, p, x, y, def) => conn || def));
    }

    async Cycle() {
        return _callSafe(() => LayoutEngine.cycleSubprofileAsync());
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

    _isStale(epoch) {
        return this._destroyed || epoch !== this._rebuildEpoch;
    }

    async updateCacheAndRebuild(fromCache = false) {
        this._rebuildEpoch = (this._rebuildEpoch || 0) + 1;
        const epoch = this._rebuildEpoch;

        try {
            const queryRequired = !fromCache || !this._displayStateCache;

            if (queryRequired) {
                const state = await LayoutEngine.getCurrentDisplayStateAsync();
                if (this._isStale(epoch)) return;
                this._displayStateCache = state;
            }

            await this._refreshAndRebuild(epoch);
        } catch (e) { _logError(e, 'Cache update failed'); }
    }

    async _refreshAndRebuild(epoch) {
        if (this._isStale(epoch)) return;
        try {
            const activeProfile = (await LayoutEngine.readTextFileAsync(LayoutEngine.ACTIVE_PROFILE_FILE))?.trim() || '';
            if (this._isStale(epoch)) return;
            const profiles = await LayoutEngine.getProfilesAsync();
            if (this._isStale(epoch)) return;

            const [, phys] = this._displayStateCache;
            const matchingProfiles = await LayoutEngine.getProfilesForHardwareAsync(phys);
            if (this._isStale(epoch)) return;

            const activeJsonStr = activeProfile ? await LayoutEngine.readTextFileAsync(`${LayoutEngine.CONFIG_DIR}/${activeProfile}.json`) : null;

            if (this._isStale(epoch)) return;
            this._rebuildMenuFromData(activeProfile, profiles, matchingProfiles, activeJsonStr);
        } catch (e) { _logError(e, 'Rebuild background sequence failed'); }
    }

    _addSectionHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.style = 'font-weight: bold; color: #888;';
        this.menu.addMenuItem(item);
    }

    _groupProfiles(profileItems) {
        const groups = new Map();
        profileItems.forEach(item => {
            const nameStr = typeof item === 'string' ? item : item.name;
            const parsed = LayoutEngine.parseProfileName(nameStr);
            if (!groups.has(parsed.group)) groups.set(parsed.group, []);
            groups.get(parsed.group).push({ ...parsed, raw: item });
        });
        return groups;
    }

    _rebuildMenuFromData(activeProfile, profiles, matchingProfiles, activeJsonStr) {
        if (this._destroyed) return;
        this.menu.removeAll();

        const matchingSet = new Set(matchingProfiles.map(m => m.name));

        this._addSectionHeader('Profiles');

        const allGroups = this._groupProfiles(profiles);

        allGroups.forEach((items, groupName) => {
            const isMatchingGroup = items.some(i => matchingSet.has(i.fullName));
            const isSingleUngrouped = items.length === 1 && !items[0].isGrouped;

            if (isSingleUngrouped) {
                const profile = items[0].fullName;
                const matchingObj = matchingProfiles.find(m => m.name === profile);
                const labelText = matchingObj?.isDefault ? `${profile} (Default)` : profile;
                const item = new PopupMenu.PopupMenuItem(labelText);
                if (profile === activeProfile) item.setOrnament(PopupMenu.Ornament.CHECK);

                item.connect('activate', async () => {
                    try {
                        await LayoutEngine.applyLayout(profile);
                        if (this._destroyed) return;
                        _notify(`Applied layout: ${profile}`);
                    } catch (err) { _notify(`Error: ${err.message}`, true); }
                });
                this.menu.addMenuItem(item);
            } else {
                const subMenuTitle = isMatchingGroup ? `${groupName} (Connected)` : groupName;
                const subMenu = new PopupMenu.PopupSubMenuMenuItem(subMenuTitle);

                items.forEach(itemData => {
                    const profile = itemData.fullName;
                    const matchingObj = matchingProfiles.find(m => m.name === profile);
                    const labelText = matchingObj?.isDefault ? `${itemData.sub} (Default)` : itemData.sub;
                    const subItem = new PopupMenu.PopupMenuItem(labelText);
                    if (profile === activeProfile) subItem.setOrnament(PopupMenu.Ornament.CHECK);

                    subItem.connect('activate', async () => {
                        try {
                            await LayoutEngine.applyLayout(profile);
                            if (this._destroyed) return;
                            _notify(`Applied layout: ${profile}`);
                        } catch (err) { _notify(`Error: ${err.message}`, true); }
                    });
                    subMenu.menu.addMenuItem(subItem);
                });
                this.menu.addMenuItem(subMenu);
            }
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (activeProfile && this._displayStateCache && activeJsonStr) {
            try {
                const profileData = JSON.parse(activeJsonStr);
                const labels = profileData.labels || {};
                const aliases = Object.keys(labels);

                if (aliases.length > 0) {
                    this._addSectionHeader('Toggle Displays');

                    const [, phys, logicalMonitors] = this._displayStateCache;
                    const connToHw = LayoutEngine.buildConnToHwMap(phys);
                    const activeHwSigs = new Set(logicalMonitors.flatMap(lm => lm[5].map(p => connToHw[p[0]])));

                    aliases.forEach(alias => {
                        const item = new PopupMenu.PopupMenuItem(alias);
                        if (activeHwSigs.has(labels[alias])) item.setOrnament(PopupMenu.Ornament.CHECK);

                        item.connect('activate', async () => {
                            try {
                                const toggles = await LayoutEngine.toggleLayouts([alias]);
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

        const saveItem = new PopupMenu.PopupMenuItem('Save Current Layout...');
        saveItem.connect('activate', () => this.triggerSaveDialog());
        this.menu.addMenuItem(saveItem);
    }

    async triggerSaveDialog() {
        if (this._destroyed) return;
        if (!this._displayStateCache) return _notify('Error: No active display state cached.', true);

        if (this._saveDialog) {
            this._saveDialog.close();
        }

        const [, phys, logicalMonitors] = this._displayStateCache;
        const monitorsToLabel = logicalMonitors.flatMap((lm, idx) =>
            lm[5].map(p => ({ connector: p[0], manufacturer: p[1], modelName: p[2], x: lm[0], y: lm[1], defaultAlias: String(idx + 1) }))
        );

        try {
            const profiles = await LayoutEngine.getProfilesAsync();
            if (this._destroyed) return;

            const existingGroups = Array.from(new Set(profiles.map(p => LayoutEngine.parseProfileName(p).group)));
            const matchingProfiles = await LayoutEngine.getProfilesForHardwareAsync(phys);
            if (this._destroyed) return;

            let suggestedGroup = '';
            if (matchingProfiles.length > 0) {
                suggestedGroup = LayoutEngine.parseProfileName(matchingProfiles[0].name).group;
            } else if (existingGroups.length > 0) {
                suggestedGroup = existingGroups[0];
            }

            this._saveDialog = new SaveLayoutDialog(
                monitorsToLabel, existingGroups, suggestedGroup,
                async (name, aliasMap, isDefault) => {
                    try {
                        await LayoutEngine.saveLayout(name, async (conn, v, p, x, y, def) => aliasMap[conn] || def, isDefault);
                        if (this._destroyed) return;
                        _notify(`Saved layout '${name}'.`);
                        await this.updateCacheAndRebuild(true);
                    } catch (err) { _notify(`Failed to save: ${err.message}`, true); }
                }
            );

            this._saveDialog.connect('destroy', () => {
                this._saveDialog = null;
            });

            this._saveDialog.open();
        } catch (err) {
            _logError(err, 'Failed to prepare save dialog');
        }
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
        _settings = this.getSettings('org.gnome.shell.extensions.display-layouts');
        this._indicator = null;
        this._lastConnectedHwSigs = null;

        this._dbusService = new DisplayLayoutsDBusService();

        this._bindings = Array.from({ length: 8 }, (_, i) => ({
            shortcutKey: `shortcut-${i+1}`, targetKey: `target-${i+1}`, actionKey: `action-${i+1}`
        }));

        this._bindings.forEach(b => {
            Main.wm.addKeybinding(b.shortcutKey, _settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, async () => {
                const action = _settings.get_string(b.actionKey);
                const target = _settings.get_string(b.targetKey).trim();

                try {
                    if (action === 'apply' && target) {
                        await LayoutEngine.applyLayout(target);
                        _notify(`Applied layout: ${target}`);
                    } else if (action === 'toggle' && target) {
                        const toggles = await LayoutEngine.toggleLayouts([target]);
                        _notify(`Toggled: ${toggles.join(', ')}`);
                    } else if (action === 'save' && this._indicator) {
                        this._indicator.triggerSaveDialog();
                    } else if (action === 'cycle') {
                        const nextProf = await LayoutEngine.cycleSubprofileAsync();
                        if (nextProf) _notify(`Cycled to layout: ${nextProf}`);
                    }
                } catch (e) { _notify(`Error: ${e.message}`, true); }
            });
        });

        this._handleAutoApply().then(() => {
            if (this._indicator) {
                this._indicator.updateCacheAndRebuild(false).catch(e => _logError(e, 'Initial indicator build failed'));
            }
        });

        this._signalId = Gio.DBus.session.signal_subscribe(
            'org.gnome.Mutter.DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged',
            '/org/gnome/Mutter/DisplayConfig', null, Gio.DBusSignalFlags.NONE,
            async () => {
                const applied = await this._handleAutoApply();

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

    async _handleAutoApply() {
        try {
            const [, phys] = await LayoutEngine.getCurrentDisplayStateAsync();
            const currentHwSet = LayoutEngine.getConnectedHwSetString(phys);

            if (currentHwSet === this._lastConnectedHwSigs) return false;

            this._latestAutoApplyId = (this._latestAutoApplyId || 0) + 1;
            const runId = this._latestAutoApplyId;

            const targetProfile = await LayoutEngine.resolveAutoApplyProfileAsync(phys);
            if (runId !== this._latestAutoApplyId || !targetProfile) {
                this._lastConnectedHwSigs = currentHwSet;
                return false;
            }

            await LayoutEngine.applyLayout(targetProfile);
            this._lastConnectedHwSigs = currentHwSet;
            _notify(`Auto-applied layout: ${targetProfile}`);
            return true;
        } catch (e) {
            _logError(e, 'Auto-apply sequence failed');
        }
        return false;
    }

    _updateIndicatorVisibility() {
        const show = _settings.get_boolean('show-indicator');
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
        if (this._signalId) { Gio.DBus.signal_unsubscribe(this._signalId); this._signalId = null; }
        _settings?.disconnectObject(this);
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        if (this._dbusService) { this._dbusService.destroy(); this._dbusService = null; }
        _settings = null;
    }
}
