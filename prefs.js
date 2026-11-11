import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ACTIONS = ['apply', 'toggle', 'save', 'cycle'];

export default class DisplayLayoutsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General Settings',
        });
        page.add(generalGroup);

        const indicatorRow = new Adw.SwitchRow({
            title: 'Show Top Bar Icon',
            subtitle: 'Toggle the visibility of the display layouts menu indicator',
        });
        generalGroup.add(indicatorRow);
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const notificationRow = new Adw.SwitchRow({
            title: 'Show Notifications',
            subtitle: 'Show system notifications for profile and layout events',
        });
        generalGroup.add(notificationRow);
        settings.bind('show-notifications', notificationRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Custom Shortcuts',
            description: 'Define up to 8 custom keyboard actions. Wrap modifiers in angle brackets, e.g. <Super>1, <Super><Shift>t.',
        });
        page.add(shortcutsGroup);

        const createGenericSlot = (prefGroup, slotIndex) => {
            const shortcutKey = `shortcut-${slotIndex}`;
            const targetKey = `target-${slotIndex}`;
            const actionKey = `action-${slotIndex}`;

            const rowGroup = new Adw.ExpanderRow({
                title: `Shortcut Slot ${slotIndex}`,
                subtitle: 'Disabled',
            });
            prefGroup.add(rowGroup);

            const updateSubtitle = () => {
                const accel = settings.get_strv(shortcutKey)[0] || '';
                const action = settings.get_string(actionKey);
                const target = settings.get_string(targetKey).trim();
                const isTargetAction = action === 'apply' || action === 'toggle';
                const targetPart = isTargetAction && target ? ` '${target}'` : '';
                rowGroup.subtitle = accel ? `${accel} → ${action}${targetPart}` : 'Disabled';
            };

            const currentAction = settings.get_string(actionKey);

            const combo = new Adw.ComboRow({
                title: 'Action Type',
                model: Gtk.StringList.new([
                    'Apply Profile',
                    'Toggle Display',
                    'Save State (Prompt Dialog)',
                    'Cycle Subprofiles (Active Setup)',
                ]),
            });
            const currentIndex = ACTIONS.indexOf(currentAction);
            combo.selected = currentIndex === -1 ? 0 : currentIndex;

            const isTargetVisible = (actionStr) => actionStr !== 'save' && actionStr !== 'cycle';

            const targetRow = new Adw.EntryRow({
                title: 'Target Name (Profile or Alias, e.g. home, left, tv)',
                text: settings.get_string(targetKey),
                visible: isTargetVisible(currentAction),
            });
            settings.bind(targetKey, targetRow, 'text', Gio.SettingsBindFlags.DEFAULT);
            targetRow.connect('notify::text', updateSubtitle);

            combo.connect('notify::selected', () => {
                const actionStr = ACTIONS[combo.selected] || 'apply';
                settings.set_string(actionKey, actionStr);
                targetRow.visible = isTargetVisible(actionStr);
                updateSubtitle();
            });
            rowGroup.add_row(combo);
            rowGroup.add_row(targetRow);

            const shortcutRow = new Adw.EntryRow({
                title: 'Keyboard Shortcut String (e.g. <Super>1, <Super><Shift>t)',
                text: settings.get_strv(shortcutKey)[0] || '',
            });
            shortcutRow.connect('changed', () => {
                const text = shortcutRow.get_text().trim();
                if (!text) {
                    settings.set_strv(shortcutKey, []);
                    updateSubtitle();
                    return;
                }
                const [ok, keyval] = Gtk.accelerator_parse(text);
                if (ok && keyval > 0) {
                    settings.set_strv(shortcutKey, [text]);
                    updateSubtitle();
                }
            });
            rowGroup.add_row(shortcutRow);

            updateSubtitle();
        };

        for (let i = 1; i <= 8; i++) {
            createGenericSlot(shortcutsGroup, i);
        }
    }
}
