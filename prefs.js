import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ACTIONS = ['apply', 'toggle', 'save'];

export default class DisplayLayoutsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // pass the schema ID explicitly to avoid lookup issues
        const settings = this.getSettings('org.gnome.shell.extensions.display-layouts');

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

        const autoApplyRow = new Adw.SwitchRow({
            title: 'Auto-Apply Profiles',
            subtitle: 'Instantly apply saved profiles matching connected displays',
        });
        generalGroup.add(autoApplyRow);
        settings.bind('enable-auto-apply', autoApplyRow, 'active', Gio.SettingsBindFlags.DEFAULT);

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
                subtitle: 'Configure a custom keybinding trigger',
            });
            prefGroup.add(rowGroup);

            const currentAction = settings.get_string(actionKey);

            // action type
            const combo = new Adw.ComboRow({
                title: 'Action Type',
                model: Gtk.StringList.new(['Apply Profile', 'Toggle Display', 'Save State (Prompt Dialog)']),
            });
            const currentIndex = ACTIONS.indexOf(currentAction);
            combo.selected = currentIndex === -1 ? 0 : currentIndex;

            // target name (hidden when action is "save")
            const targetRow = new Adw.EntryRow({
                title: 'Target Name (Profile or Alias, e.g. home, left, tv)',
                text: settings.get_string(targetKey),
                visible: (currentAction !== 'save'),
            });
            settings.bind(targetKey, targetRow, 'text', Gio.SettingsBindFlags.DEFAULT);

            combo.connect('notify::selected', () => {
                const actionStr = ACTIONS[combo.selected] || 'apply';
                settings.set_string(actionKey, actionStr);
                targetRow.visible = (actionStr !== 'save');
            });
            rowGroup.add_row(combo);
            rowGroup.add_row(targetRow);

            // shortcut keybinding
            const shortcutRow = new Adw.EntryRow({
                title: 'Keyboard Shortcut String (e.g. <Super>1, <Super><Shift>t)',
                text: settings.get_strv(shortcutKey)[0] || '',
            });
            shortcutRow.connect('changed', () => {
                const text = shortcutRow.get_text().trim();
                settings.set_strv(shortcutKey, text ? [text] : []);
            });
            rowGroup.add_row(shortcutRow);
        };

        // build all 8 slots
        for (let i = 1; i <= 8; i++) {
            createGenericSlot(shortcutsGroup, i);
        }
    }
}