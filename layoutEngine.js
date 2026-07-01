import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CONFIG_DIR = `${GLib.get_home_dir()}/.config/display-layouts`;
export const ACTIVE_PROFILE_FILE = `${CONFIG_DIR}/.active_profile`;

const DBUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const DBUS_PATH = '/org/gnome/Mutter/DisplayConfig';
const DBUS_IFACE = 'org.gnome.Mutter.DisplayConfig';

// Low-level, non-blocking asynchronous direct D-Bus call to Mutter
export async function callMutterAsync(methodName, variantArgs) {
    let reply = await Gio.DBus.session.call(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_IFACE,
        methodName,
        variantArgs,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );
    return reply;
}

export async function getCurrentDisplayStateAsync() {
    let state = await callMutterAsync("GetCurrentState", null);
    return state.recursiveUnpack();
}

export function writeTextFileAsync(filePath, content) {
    return new Promise((resolve, reject) => {
        let file = Gio.File.new_for_path(filePath);
        let parent = file.get_parent();
        if (parent && !parent.query_exists(null)) {
            parent.make_directory_with_parents(null);
        }

        const encoder = new TextEncoder();
        const bytes = encoder.encode(content);

        file.replace_contents_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (fileObj, res) => {
                try {
                    fileObj.replace_contents_finish(res);
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

export function readTextFileAsync(filePath) {
    return new Promise((resolve) => {
        let file = Gio.File.new_for_path(filePath);
        file.load_contents_async(null, (fileObj, res) => {
            try {
                let [success, contents] = fileObj.load_contents_finish(res);
                if (success) {
                    let decoder = new TextDecoder();
                    resolve(decoder.decode(contents));
                } else {
                    resolve(null);
                }
            } catch (e) {
                resolve(null);
            }
        });
    });
}

// 100% Asynchronous, non-blocking recursive directory scanning
export function getProfilesAsync() {
    return new Promise((resolve) => {
        let profiles = [];
        let dir = Gio.File.new_for_path(CONFIG_DIR);
        
        if (!dir.query_exists(null)) {
            resolve([]);
            return;
        }

        dir.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (dirObj, res) => {
                try {
                    let enumerator = dirObj.enumerate_children_finish(res);
                    let getNextFile = () => {
                        enumerator.next_files_async(
                            100,
                            GLib.PRIORITY_DEFAULT,
                            null,
                            (enumObj, enumRes) => {
                                try {
                                    let files = enumObj.next_files_finish(enumRes);
                                    if (files.length === 0) {
                                        enumerator.close(null);
                                        resolve(profiles.sort());
                                        return;
                                    }
                                    files.forEach(fileInfo => {
                                        let name = fileInfo.get_name();
                                        if (name.endsWith('.json')) {
                                            profiles.push(name.substring(0, name.length - 5));
                                        }
                                    });
                                    getNextFile();
                                } catch (e) {
                                    resolve(profiles.sort());
                                }
                            }
                        );
                    };
                    getNextFile();
                } catch (e) {
                    resolve([]);
                }
            }
        );
    });
}

// Generate unique physical display signature
export function getHwSig(physInfo) {
    let [_, vendor, prod, serial] = physInfo;
    return `${vendor}_${prod}_${serial}`.replace(/\s+/g, '');
}

export function getActiveMode(modes) {
    for (let m of modes) {
        if (m[6] && m[6]['is-current']) {
            return m[0];
        }
    }
    for (let m of modes) {
        if (m[6] && m[6]['is-preferred']) {
            return m[0];
        }
    }
    return modes.length > 0 ? modes[0][0] : "";
}

// Core DBus Apply Logic: heals, offsets, and sends structure
export async function applyLayoutToDBus(proxy, serial, logicalMonitors, livePrimaryHwSig, profilePrimaryHwSig) {
    if (!logicalMonitors || logicalMonitors.length === 0) {
        throw new Error("No logical monitors to apply.");
    }

    let lmList = logicalMonitors.map(lm => {
        return [
            lm[0], // x
            lm[1], // y
            lm[2], // scale
            lm[3], // transform
            false, // primary
            lm[5], // monitors array
            lm[6]  // hw_sigs
        ];
    });

    let primaryIndex = -1;

    if (profilePrimaryHwSig) {
        for (let i = 0; i < lmList.length; i++) {
            if (lmList[i][6] && lmList[i][6].includes(profilePrimaryHwSig)) {
                primaryIndex = i;
                break;
            }
        }
    }

    if (primaryIndex === -1 && livePrimaryHwSig) {
        for (let i = 0; i < lmList.length; i++) {
            if (lmList[i][6] && lmList[i][6].includes(livePrimaryHwSig)) {
                primaryIndex = i;
                break;
            }
        }
    }

    if (primaryIndex === -1 && lmList.length > 0) {
        primaryIndex = 0;
    }

    if (primaryIndex !== -1) {
        lmList[primaryIndex][4] = true;
    }

    let minX = Math.min(...lmList.map(lm => lm[0]));
    let minY = Math.min(...lmList.map(lm => lm[1]));
    if (minX > 0 || minY > 0) {
        for (let lm of lmList) {
            lm[0] -= minX;
            lm[1] -= minY;
        }
    }

    let finalLm = [];
    for (let lm of lmList) {
        let [x, y, scale, transform, primary, mons] = lm;
        let mList = mons.map(m => [m[0], m[1], m[2] || {}]);
        finalLm.push([
            Number(x),
            Number(y),
            Number(scale),
            Number(transform),
            Boolean(primary),
            mList
        ]);
    }

    let properties = {};
    let variant = new GLib.Variant(
        "(uua(iiduba(ssa{sv}))a{sv})",
        [
            Number(serial),
            3,
            finalLm,
            properties
        ]
    );

    await callMutterAsync("ApplyMonitorsConfig", variant);
}

// Command: Save active state
export async function saveLayout(name, aliasResolver) {
    let state = await getCurrentDisplayStateAsync();
    let [serial, phys, logical, props] = state;

    let activeModes = {};
    for (let p of phys) {
        let hwSig = getHwSig(p[0]);
        activeModes[hwSig] = getActiveMode(p[1]);
    }

    let labels = {};
    let savedLogical = [];

    for (let idx = 0; idx < logical.length; idx++) {
        let lm = logical[idx];
        let [x, y, scale, transform, primary, physList] = lm;
        let savedPhys = [];

        for (let p of physList) {
            let hwSig = getHwSig(p);
            let modeId = activeModes[hwSig] || "";
            savedPhys.push({
                hw_sig: hwSig,
                mode_id: modeId,
                props: {}
            });

            let conn = p[0];
            let manufacturer = p[1];
            let modelName = p[2];
            let defaultAlias = String(idx + 1);

            let alias = await aliasResolver(conn, manufacturer, modelName, x, y, defaultAlias);
            labels[alias] = hwSig;
        }

        savedLogical.push({
            x: x,
            y: y,
            scale: scale,
            transform: transform,
            primary: primary,
            monitors: savedPhys
        });
    }

    let profile = {
        name: name,
        labels: labels,
        logical_monitors: savedLogical
    };

    let profilePath = `${CONFIG_DIR}/${name}.json`;
    await writeTextFileAsync(profilePath, JSON.stringify(profile, null, 2));
    await writeTextFileAsync(ACTIVE_PROFILE_FILE, name);
}

export async function applyLayout(name) {
    let profilePath = `${CONFIG_DIR}/${name}.json`;
    let content = await readTextFileAsync(profilePath);
    if (!content) {
        throw new Error(`Profile '${name}' does not exist.`);
    }

    let profile = JSON.parse(content);
    let state = await getCurrentDisplayStateAsync();
    let [serial, phys, logical, props] = state;

    let livePrimaryHwSig = null;
    for (let lm of logical) {
        if (lm[4] && lm[5] && lm[5].length > 0) {
            livePrimaryHwSig = getHwSig(lm[5][0]);
            break;
        }
    }

    let profilePrimaryHwSig = null;
    for (let slm of profile.logical_monitors) {
        if (slm.primary && slm.monitors && slm.monitors.length > 0) {
            profilePrimaryHwSig = slm.monitors[0].hw_sig;
            break;
        }
    }

    let hwToConn = {};
    for (let p of phys) {
        hwToConn[getHwSig(p[0])] = p[0][0];
    }

    let newLogical = [];
    for (let slm of profile.logical_monitors) {
        let monitorsArray = [];
        let lmHwSigs = [];
        for (let sm of slm.monitors) {
            let hwSig = sm.hw_sig;
            if (!(hwSig in hwToConn)) {
                throw new Error(`Required monitor '${hwSig}' is not physically connected.`);
            }
            monitorsArray.push([hwToConn[hwSig], sm.mode_id, sm.props || {}]);
            lmHwSigs.push(hwSig);
        }

        newLogical.push([
            slm.x, slm.y, slm.scale, slm.transform,
            slm.primary, monitorsArray, lmHwSigs
        ]);
    }

    await applyLayoutToDBus(serial, newLogical, livePrimaryHwSig, profilePrimaryHwSig);
    await writeTextFileAsync(ACTIVE_PROFILE_FILE, name);
}

export async function toggleLayouts(aliases) {
    let activeProfileContent = await readTextFileAsync(ACTIVE_PROFILE_FILE);
    if (!activeProfileContent) {
        throw new Error("No active profile. Apply or save a profile first.");
    }

    let activeName = activeProfileContent.trim();
    let profilePath = `${CONFIG_DIR}/${activeName}.json`;
    let content = await readTextFileAsync(profilePath);
    if (!content) {
        throw new Error(`Profile '${activeName}' data not found.`);
    }

    let profile = JSON.parse(content);
    let state = await getCurrentDisplayStateAsync();
    let [serial, phys, logical, props] = state;

    let hwToConn = {};
    for (let p of phys) {
        hwToConn[getHwSig(p[0])] = p[0][0];
    }

    let livePrimaryHwSig = null;
    for (let lm of logical) {
        if (lm[4] && lm[5] && lm[5].length > 0) {
            livePrimaryHwSig = getHwSig(lm[5][0]);
            break;
        }
    }

    let profilePrimaryHwSig = null;
    for (let slm of profile.logical_monitors) {
        if (slm.primary && slm.monitors && slm.monitors.length > 0) {
            profilePrimaryHwSig = slm.monitors[0].hw_sig;
            break;
        }
    }

    let desiredHws = new Set();
    for (let lm of logical) {
        for (let p of lm[5]) {
            desiredHws.add(getHwSig(p));
        }
    }

    let toggleStates = [];
    for (let alias of aliases) {
        let targetHwSig = profile.labels && profile.labels[alias];
        if (!targetHwSig) {
            throw new Error(`Alias '${alias}' not found in active profile '${activeName}'.`);
        }

        if (!(targetHwSig in hwToConn)) {
            throw new Error("Safety Halt: Target monitor '" + alias + "' is not physically connected.");
        }

        if (desiredHws.has(targetHwSig)) {
            desiredHws.delete(targetHwSig);
            toggleStates.push(`'${alias}' OFF`);
        } else {
            desiredHws.add(targetHwSig);
            toggleStates.push(`'${alias}' ON`);
        }
    }

    if (desiredHws.size === 0) {
        throw new Error("Cannot disable the last active monitor.");
    }

    let newLogical = [];
    for (let slm of profile.logical_monitors) {
        let keptMons = [];
        let lmHwSigs = [];
        for (let sm of slm.monitors) {
            if (desiredHws.has(sm.hw_sig)) {
                if (!(sm.hw_sig in hwToConn)) {
                    continue;
                }
                keptMons.push([hwToConn[sm.hw_sig], sm.mode_id, sm.props || {}]);
                lmHwSigs.push(sm.hw_sig);
            }
        }

        if (keptMons.length > 0) {
            newLogical.push([
                slm.x, slm.y, slm.scale, slm.transform,
                slm.primary, keptMons, lmHwSigs
            ]);
        }
    }

    await applyLayoutToDBus(serial, newLogical, livePrimaryHwSig, profilePrimaryHwSig);
    return toggleStates;
}
