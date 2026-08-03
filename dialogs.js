// dialogs.js
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { CheckBox } from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const SaveLayoutDialog = GObject.registerClass({
    GTypeName: 'DisplayLayoutsSaveDialog',
}, class SaveLayoutDialog extends ModalDialog.ModalDialog {
    _init(monitors, existingGroups, suggestedGroup, callback) {
        super._init({
            styleClass: 'save-layout-dialog',
            destroyOnClose: true,
        });
        this._callback = callback;
        this._existingGroups = existingGroups || [];
        const initialGroup = suggestedGroup || (this._existingGroups[0] || '');

        const titleLabel = new St.Label({
            text: 'Save Display Layout',
            style: 'font-weight: bold; font-size: 1.3em; margin-bottom: 15px;',
        });
        this.contentLayout.add_child(titleLabel);

        if (this._existingGroups.length > 0) {
            const chipsHeader = new St.Label({
                text: 'Select Group:',
                style: 'font-weight: bold; margin-bottom: 5px;',
            });
            this.contentLayout.add_child(chipsHeader);

            const groupChipsRow = new St.BoxLayout({
                vertical: false,
                style: 'margin-bottom: 10px; spacing: 5px; flex-wrap: wrap;',
            });

            this._existingGroups.forEach(grp => {
                const btn = new St.Button({
                    label: grp,
                    style_class: 'button',
                    can_focus: true,
                    style: 'padding: 4px 10px;',
                });
                btn.connect('clicked', () => {
                    this._groupEntry.set_text(grp);
                    this._subprofileEntry.grab_key_focus();
                });
                groupChipsRow.add_child(btn);
            });

            const newGrpBtn = new St.Button({
                label: '+ New Group',
                style_class: 'button',
                can_focus: true,
                style: 'padding: 4px 10px;',
            });
            newGrpBtn.connect('clicked', () => {
                this._groupEntry.set_text('');
                this._groupEntry.grab_key_focus();
            });
            groupChipsRow.add_child(newGrpBtn);

            this.contentLayout.add_child(groupChipsRow);
        }

        const groupLabel = new St.Label({
            text: 'Group Name:',
            style: 'font-weight: bold; margin-bottom: 5px;',
        });
        this.contentLayout.add_child(groupLabel);

        this._groupEntry = new St.Entry({
            can_focus: true,
            text: initialGroup,
            hint_text: 'e.g. Home, Work',
            style: 'margin-bottom: 10px; width: 335px;',
        });
        this._groupEntry.clutter_text.connect('activate', () => this._subprofileEntry.grab_key_focus());
        this.contentLayout.add_child(this._groupEntry);

        const subLabel = new St.Label({
            text: 'Subprofile Name:',
            style: 'font-weight: bold; margin-bottom: 5px;',
        });
        this.contentLayout.add_child(subLabel);

        this._subprofileEntry = new St.Entry({
            can_focus: true,
            hint_text: 'e.g. full, dual, gaming',
            style: 'margin-bottom: 15px; width: 335px;',
        });
        this._subprofileEntry.clutter_text.connect('activate', () => this._saveAction());
        this.contentLayout.add_child(this._subprofileEntry);

        this._defaultCheck = new CheckBox('Set as default subprofile for this hardware');
        this._defaultCheck.style = 'margin-bottom: 15px;';
        this.contentLayout.add_child(this._defaultCheck);

        this.setInitialKeyFocus(initialGroup ? this._subprofileEntry : this._groupEntry);

        const aliasesHeader = new St.Label({
            text: 'Assign Display Aliases (e.g. left, tv):',
            style: 'font-weight: bold; margin-bottom: 10px;',
        });
        this.contentLayout.add_child(aliasesHeader);

        this._monitorEntries = [];

        monitors.forEach(m => {
            const row = new St.BoxLayout({
                vertical: false,
                style: 'margin-bottom: 10px; align-items: center;',
            });

            const labelText = `${m.manufacturer} ${m.modelName} (${m.connector})`;
            const label = new St.Label({
                text: labelText,
                style: 'width: 200px; font-size: 0.9em; margin-right: 15px;',
            });
            row.add_child(label);

            const entry = new St.Entry({
                can_focus: true,
                hint_text: m.defaultAlias,
                text: m.connector,
                style: 'width: 120px;',
            });
            entry.clutter_text.connect('activate', () => this._saveAction());
            row.add_child(entry);

            this.contentLayout.add_child(row);

            this._monitorEntries.push({
                connector: m.connector,
                entry,
                defaultAlias: m.defaultAlias,
            });
        });

        this.addButton({
            label: 'Cancel',
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });

        this.addButton({
            label: 'Save Profile',
            action: () => this._saveAction(),
            key: Clutter.KEY_Return,
        });
    }

    _saveAction() {
        const group = this._groupEntry.get_text().trim();
        const sub = this._subprofileEntry.get_text().trim();

        if (!group && !sub) {
            Main.notify('Display Layouts', 'Error: Group or profile name is required.');
            return;
        }

        let fullName = '';
        if (group && sub) {
            fullName = `${group}:${sub}`;
        } else {
            fullName = group || sub;
        }

        const aliasMap = {};
        this._monitorEntries.forEach(item => {
            const enteredAlias = item.entry.get_text().trim();
            aliasMap[item.connector] = enteredAlias || item.defaultAlias;
        });

        const isDefault = this._defaultCheck.checked;
        this._callback(fullName, aliasMap, isDefault);
        this.close();
    }
});
