import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CONFIG_DIR = `${GLib.get_home_dir()}/.config/display-layouts`;
export const ACTIVE_PROFILE_FILE = `${CONFIG_DIR}/.active_profile`;

const DBUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const DBUS_PATH = '/org/gnome/Mutter/DisplayConfig';
const DBUS_IFACE = 'org.gnome.Mutter.DisplayConfig';

// Direct asynchronous D-Bus bridge
export async function callMutterAsync(methodName, variantArgs) {
    return await Gio.DBus.session.call(
        DBUS_NAME, DBUS_PATH, DBUS_IFACE, methodName, variantArgs,
        null, Gio.DBusCallFlags.NONE, -1, null
    );
}

export async function getCurrentDisplayStateAsync() {
    let reply = await callMutterAsync("GetCurrentState", null);
    return reply.recursiveUnpack();
}

export function writeTextFileAsync(filePath, content) {
    return new Promise((resolve, reject) => {
        let file = Gio.File.new_for_path(filePath);
        let parent = file.get_parent();
        if (parent && !parent.query_exists(null)) {
            parent.make_directory_with_parents(null);
        }
        const bytes = new TextEncoder().encode(content);
        file.replace_contents_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
            try { f.replace_contents_finish(res); resolve(true); } 
            catch (e) { reject(e); }
        });
    });
}

export function readTextFileAsync(filePath) {
    return new Promise((resolve) => {
        Gio.File.new_for_path(filePath).load_contents_async(null, (f, res) => {
            try {
                let [success, contents] = f.load_contents_finish(res);
                resolve(success ? new TextDecoder().decode(contents) : null);
            } catch (e) { resolve(null); }
        });
    });
}

export function getProfilesAsync() {
    return new Promise((resolve) => {
        let dir = Gio.File.new_for_path(CONFIG_DIR);
        if (!dir.query_exists(null)) return resolve([]);

        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (d, res) => {
            try {
                let enumerator = d.enumerate_children_finish(res);
                let profiles = [];
                let fetchNext = () => {
                    enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, null, (e, enumRes) => {
                        try {
                            let files = e.next_files_finish(enumRes);
                            if (files.length === 0) {
                                enumerator.close(null);
                                return resolve(profiles.sort());
                            }
                            files.forEach(file => {
                                let name = file.get_name();
                                if (name.endsWith('.json')) profiles.push(name.substring(0, name.length - 5));
                            });
                            fetchNext();
                        } catch (err) { resolve(profiles.sort()); }
                    });
                };
                fetchNext();
            } catch (err) { resolve([]); }
        });
    });
}

export function getHwSig(physInfo) {
    let [_, vendor, prod, serial] = physInfo;
    return `${vendor}_${prod}_${serial}`.replace(/\s+/g, '');
}

export function getActiveMode(modes) {
    let current = modes.find(m => m[6] && m[6]['is-current']);
    if (current) return current[0];
    let preferred = modes.find(m => m[6] && m[6]['is-preferred']);
    return preferred ? preferred[0] : (modes.length ? modes[0][0] : "");
}

// Core DBus Apply Logic: heals, offsets, and formats the GVariant payload
export async function applyLayoutToDBus(serial, logicalMonitors, livePrimaryHwSig, profilePrimaryHwSig) {
    if (!logicalMonitors || logicalMonitors.length === 0) throw new Error("No logical monitors to apply.");

    let lmList = logicalMonitors.map(lm => [lm[0], lm[1], lm[2], lm[3], false, lm[5], lm[6]]);
    let primaryIndex = -1;

    if (profilePrimaryHwSig) primaryIndex = lmList.findIndex(lm => lm[6] && lm[6].includes(profilePrimaryHwSig));
    if (primaryIndex === -1 && livePrimaryHwSig) primaryIndex = lmList.findIndex(lm => lm[6] && lm[6].includes(livePrimaryHwSig));
    if (primaryIndex === -1) primaryIndex = 0;
    
    lmList[primaryIndex][4] = true;

    let minX = Math.min(...lmList.map(lm => lm[0]));
    let minY = Math.min(...lmList.map(lm => lm[1]));
    if (minX > 0 || minY > 0) lmList.forEach(lm => { lm[0] -= minX; lm[1] -= minY; });

    let finalLm = lmList.map(lm => [
        Number(lm[0]), Number(lm[1]), Number(lm[2]), Number(lm[3]), Boolean(lm[4]),
        lm[5].map(m => [m[0], m[1], m[2] || {}])
    ]);

    let variant = new GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", [Number(serial), 3, finalLm, {}]);
    await callMutterAsync("ApplyMonitorsConfig", variant);
}

export async function saveLayout(name, aliasResolver) {
    let [serial, phys, logical, props] = await getCurrentDisplayStateAsync();
    let activeModes = Object.fromEntries(phys.map(p => [getHwSig(p[0]), getActiveMode(p[1])]));
    let labels = {};
    let savedLogical = [];

    for (let idx = 0; idx < logical.length; idx++) {
        let [x, y, scale, transform, primary, physList] = logical[idx];
        let savedPhys = [];

        for (let p of physList) {
            let hwSig = getHwSig(p);
            savedPhys.push({ hw_sig: hwSig, mode_id: activeModes[hwSig] || "", props: {} });
            labels[await aliasResolver(p[0], p[1], p[2], x, y, String(idx + 1))] = hwSig;
        }
        savedLogical.push({ x, y, scale, transform, primary, monitors: savedPhys });
    }

    let profile = { name, labels, logical_monitors: savedLogical };
    await writeTextFileAsync(`${CONFIG_DIR}/${name}.json`, JSON.stringify(profile, null, 2));
    await writeTextFileAsync(ACTIVE_PROFILE_FILE, name);
}

export async function applyLayout(name) {
    let content = await readTextFileAsync(`${CONFIG_DIR}/${name}.json`);
    if (!content) throw new Error(`Profile '${name}' does not exist.`);

    let profile = JSON.parse(content);
    let [serial, phys, logical, props] = await getCurrentDisplayStateAsync();

    let livePrimary = logical.find(lm => lm[4] && lm[5].length > 0);
    let livePrimaryHwSig = livePrimary ? getHwSig(livePrimary[5][0]) : null;

    let profilePrimary = profile.logical_monitors.find(slm => slm.primary && slm.monitors.length > 0);
    let profilePrimaryHwSig = profilePrimary ? profilePrimary.monitors[0].hw_sig : null;

    let hwToConn = Object.fromEntries(phys.map(p => [getHwSig(p[0]), p[0][0]]));
    let newLogical = [];

    for (let slm of profile.logical_monitors) {
        let monitorsArray = [], lmHwSigs = [];
        for (let sm of slm.monitors) {
            if (!(sm.hw_sig in hwToConn)) throw new Error(`Monitor '${sm.hw_sig}' is disconnected or asleep.`);
            monitorsArray.push([hwToConn[sm.hw_sig], sm.mode_id, sm.props || {}]);
            lmHwSigs.push(sm.hw_sig);
        }
        newLogical.push([slm.x, slm.y, slm.scale, slm.transform, slm.primary, monitorsArray, lmHwSigs]);
    }

    await applyLayoutToDBus(serial, newLogical, livePrimaryHwSig, profilePrimaryHwSig);
    await writeTextFileAsync(ACTIVE_PROFILE_FILE, name);
}

export async function toggleLayouts(aliases) {
    let activeName = await readTextFileAsync(ACTIVE_PROFILE_FILE);
    if (!activeName) throw new Error("No active profile.");
    activeName = activeName.trim();

    let content = await readTextFileAsync(`${CONFIG_DIR}/${activeName}.json`);
    if (!content) throw new Error(`Profile '${activeName}' missing.`);

    let profile = JSON.parse(content);
    let [serial, phys, logical, props] = await getCurrentDisplayStateAsync();
    let hwToConn = Object.fromEntries(phys.map(p => [getHwSig(p[0]), p[0][0]]));

    let livePrimary = logical.find(lm => lm[4] && lm[5].length > 0);
    let livePrimaryHwSig = livePrimary ? getHwSig(livePrimary[5][0]) : null;

    let profilePrimary = profile.logical_monitors.find(slm => slm.primary && slm.monitors.length > 0);
    let profilePrimaryHwSig = profilePrimary ? profilePrimary.monitors[0].hw_sig : null;

    let desiredHws = new Set(logical.flatMap(lm => lm[5].map(getHwSig)));
    let toggleStates = [];

    for (let alias of aliases) {
        let targetHwSig = profile.labels?.[alias];
        if (!targetHwSig) throw new Error(`Alias '${alias}' not found.`);
        if (!(targetHwSig in hwToConn)) throw new Error(`Display '${alias}' is disconnected or asleep.`);

        if (desiredHws.has(targetHwSig)) {
            desiredHws.delete(targetHwSig);
            toggleStates.push(`'${alias}' OFF`);
        } else {
            desiredHws.add(targetHwSig);
            toggleStates.push(`'${alias}' ON`);
        }
    }

    if (desiredHws.size === 0) throw new Error("Cannot disable the last active monitor.");

    let newLogical = [];
    for (let slm of profile.logical_monitors) {
        let keptMons = [], lmHwSigs = [];
        for (let sm of slm.monitors) {
            if (desiredHws.has(sm.hw_sig) && sm.hw_sig in hwToConn) {
                keptMons.push([hwToConn[sm.hw_sig], sm.mode_id, sm.props || {}]);
                lmHwSigs.push(sm.hw_sig);
            }
        }
        if (keptMons.length > 0) {
            newLogical.push([slm.x, slm.y, slm.scale, slm.transform, slm.primary, keptMons, lmHwSigs]);
        }
    }

    await applyLayoutToDBus(serial, newLogical, livePrimaryHwSig, profilePrimaryHwSig);
    return toggleStates;
}
