import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const SaveLayoutDialog = GObject.registerClass({
    GTypeName: 'DisplayLayoutsSaveDialog',
}, class SaveLayoutDialog extends ModalDialog.ModalDialog {
    _init(monitors, callback) {
        super._init({
            styleClass: 'save-layout-dialog',
            destroyOnClose: true,
        });
        this._monitors = monitors;
        this._callback = callback;

        // Title
        const titleLabel = new St.Label({
            text: 'Save Display Layout',
            style: 'font-weight: bold; font-size: 1.3em; margin-bottom: 15px;',
        });
        this.contentLayout.add_child(titleLabel);

        // Profile Name Area
        const nameLabel = new St.Label({
            text: 'Profile Name:',
            style: 'font-weight: bold; margin-bottom: 5px;',
        });
        this.contentLayout.add_child(nameLabel);

        this._nameEntry = new St.Entry({
            can_focus: true,
            hint_text: 'e.g. home, work, docking',
            style: 'margin-bottom: 20px; width: 335px;',
        });
        this.contentLayout.add_child(this._nameEntry);

        // Section Header
        const aliasesHeader = new St.Label({
            text: 'Assign Display Aliases (e.g. left, tv):',
            style: 'font-weight: bold; margin-bottom: 10px;',
        });
        this.contentLayout.add_child(aliasesHeader);

        this._monitorEntries = [];
        
        // Loop through active monitors to generate input rows
        this._monitors.forEach(m => {
            let row = new St.BoxLayout({
                vertical: false,
                style: 'margin-bottom: 10px; align-items: center;',
            });

            let labelText = `${m.manufacturer} ${m.modelName} (${m.connector})`;
            let label = new St.Label({
                text: labelText,
                style: 'width: 200px; font-size: 0.9em; margin-right: 15px;',
            });
            row.add_child(label);

            let entry = new St.Entry({
                can_focus: true,
                hint_text: m.defaultAlias,
                text: m.connector, // Pre-fill with the port as a logical default
                style: 'width: 120px;',
            });
            row.add_child(entry);

            this.contentLayout.add_child(row);
            
            this._monitorEntries.push({
                connector: m.connector,
                entry: entry,
                defaultAlias: m.defaultAlias
            });
        });

        this.addButton({
            label: 'Cancel',
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });

        this.addButton({
            label: 'Save Profile',
            action: () => {
                let name = this._nameEntry.get_text().trim();
                if (!name) {
                    Main.notify('Display Layouts', 'Error: Profile name is required.');
                    return;
                }

                // Map the connectors to their corresponding visual entries
                let aliasMap = {};
                this._monitorEntries.forEach(item => {
                    let enteredAlias = item.entry.get_text().trim();
                    aliasMap[item.connector] = enteredAlias || item.defaultAlias;
                });

                this._callback(name, aliasMap);
                this.close();
            },
            key: Clutter.KEY_Return,
        });
    }
});
