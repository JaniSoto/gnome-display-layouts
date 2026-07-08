import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DisplayLayoutsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Explicitly pass the schema ID to avoid GNOME Shell sharedInternals lookup failures
        let settings = this.getSettings('org.gnome.shell.extensions.display-layouts');

        let page = new Adw.PreferencesPage();
        window.add(page);

        // General settings group
        let generalGroup = new Adw.PreferencesGroup({
            title: 'General Settings',
        });
        page.add(generalGroup);

        let indicatorRow = new Adw.SwitchRow({
            title: 'Show Top Bar Icon',
            subtitle: 'Toggle the visibility of the display layouts menu indicator',
        });
        generalGroup.add(indicatorRow);
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        let notificationRow = new Adw.SwitchRow({
            title: 'Show Notifications',
            subtitle: 'Show system notifications for profile and layout events',
        });
        generalGroup.add(notificationRow);
        settings.bind('show-notifications', notificationRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        let autoApplyRow = new Adw.SwitchRow({
            title: 'Auto-Apply Profiles',
            subtitle: 'Instantly apply saved profiles matching connected displays',
        });
        generalGroup.add(autoApplyRow);
        settings.bind('enable-auto-apply', autoApplyRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Custom shortcuts group
        let shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Custom Shortcuts',
            description: 'Define up to 8 custom keyboard actions. Wrap modifiers in angle brackets, e.g. <Super>1, <Super><Shift>t.',
        });
        page.add(shortcutsGroup);

        const createGenericSlot = (prefGroup, slotIndex) => {
            const shortcutKey = `shortcut-${slotIndex}`;
            const targetKey = `target-${slotIndex}`;
            const actionKey = `action-${slotIndex}`;

            let rowGroup = new Adw.ExpanderRow({
                title: `Shortcut Slot ${slotIndex}`,
                subtitle: 'Configure a custom keybinding trigger',
            });
            prefGroup.add(rowGroup);

            let currentAction = settings.get_string(actionKey);

            // 1. Action Type Dropdown Selection
            let combo = new Adw.ComboRow({
                title: 'Action Type',
                model: Gtk.StringList.new(['Apply Profile', 'Toggle Display', 'Save State (Prompt Dialog)']),
            });

            // Map GSettings action to drop-down selection index
            if (currentAction === 'toggle') combo.selected = 1;
            else if (currentAction === 'save') combo.selected = 2;
            else combo.selected = 0;

            // 2. Target string input (ignored when action is "save")
            let targetRow = new Adw.EntryRow({
                title: 'Target Name (Profile or Alias, e.g. home, left, tv)',
                text: settings.get_string(targetKey),
                visible: (currentAction !== 'save'),
            });
            settings.bind(targetKey, targetRow, 'text', Gio.SettingsBindFlags.DEFAULT);

            combo.connect('notify::selected', () => {
                let selected = combo.selected;
                let actionStr = 'apply';
                if (selected === 1) actionStr = 'toggle';
                else if (selected === 2) actionStr = 'save';
                settings.set_string(actionKey, actionStr);

                // Dynamically adjust visibility of the Target Name row
                targetRow.visible = (actionStr !== 'save');
            });
            rowGroup.add_row(combo);
            rowGroup.add_row(targetRow);

            // 3. Key combination input
            let shortcutRow = new Adw.EntryRow({
                title: 'Keyboard Shortcut String (e.g. <Super>1, <Super><Shift>t)',
                text: settings.get_strv(shortcutKey)[0] || '',
            });
            shortcutRow.connect('changed', () => {
                let text = shortcutRow.get_text().trim();
                if (text) {
                    settings.set_strv(shortcutKey, [text]);
                } else {
                    settings.set_strv(shortcutKey, []);
                }
            });
            rowGroup.add_row(shortcutRow);
        };

        // Populate the 8 generic slots
        for (let i = 1; i <= 8; i++) {
            createGenericSlot(shortcutsGroup, i);
        }
    }
}
