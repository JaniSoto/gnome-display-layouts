import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CONFIG_DIR = `${GLib.get_home_dir()}/.config/display-layouts`;
export const ACTIVE_PROFILE_FILE = `${CONFIG_DIR}/.active_profile`;

const DBUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const DBUS_PATH = '/org/gnome/Mutter/DisplayConfig';
const DBUS_IFACE = 'org.gnome.Mutter.DisplayConfig';

// async D-Bus call wrapper
async function callMutterAsync(methodName, variantArgs) {
    return await Gio.DBus.session.call(
        DBUS_NAME, DBUS_PATH, DBUS_IFACE, methodName, variantArgs,
        null, Gio.DBusCallFlags.NONE, -1, null
    );
}

export async function getCurrentDisplayStateAsync() {
    const reply = await callMutterAsync("GetCurrentState", null);
    return reply.recursiveUnpack();
}

async function writeTextFileAsync(filePath, content) {
    const file = Gio.File.new_for_path(filePath);
    const parent = file.get_parent();

    // ensure the config directory exists
    if (parent) {
        await new Promise(resolve => {
            parent.make_directory_async(GLib.PRIORITY_DEFAULT, null, (p, res) => {
                try { p.make_directory_finish(res); } catch (e) {} // already exists
                resolve();
            });
        });
    }

    const bytes = new TextEncoder().encode(content);
    return new Promise((resolve, reject) => {
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
                const [success, contents] = f.load_contents_finish(res);
                resolve(success ? new TextDecoder().decode(contents) : null);
            } catch (e) { resolve(null); }
        });
    });
}

export function getProfilesAsync() {
    return new Promise((resolve) => {
        const dir = Gio.File.new_for_path(CONFIG_DIR);
        // async listing; a missing directory is handled in the outer catch
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (d, res) => {
            try {
                const enumerator = d.enumerate_children_finish(res);
                const profiles = [];
                const fetchNext = () => {
                    enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, null, (e, enumRes) => {
                        try {
                            const files = e.next_files_finish(enumRes);
                            if (files.length === 0) {
                                enumerator.close(null);
                                return resolve(profiles.sort());
                            }
                            files.forEach(file => {
                                const name = file.get_name();
                                if (name.endsWith('.json')) profiles.push(name.substring(0, name.length - 5));
                            });
                            fetchNext();
                        } catch (err) { resolve(profiles.sort()); }
                    });
                };
                fetchNext();
            } catch (err) {
                resolve([]); // config directory doesn't exist yet
            }
        });
    });
}

export function getHwSig(physInfo) {
    const [_, vendor, prod, serial] = physInfo;
    return `${vendor}_${prod}_${serial}`.replace(/\s+/g, '');
}

// hardware-set fingerprint for the currently connected monitors, used to
// detect when the physical display configuration has changed
export function getConnectedHwSetString(phys) {
    return phys.map(p => getHwSig(p[0])).sort().join(',');
}

// connector -> unique hardware signature, e.g. "DP-1" -> "Goldstar_Model_0_1"
export function buildConnToHwMap(phys) {
    const counts = {};
    return Object.fromEntries(phys.map(p => {
        const base = getHwSig(p[0]);
        counts[base] = (counts[base] || 0) + 1;
        const uniqueSig = `${base}_${counts[base]}`;
        return [p[0][0], uniqueSig];
    }));
}

// inverse of buildConnToHwMap: hardware signature -> connector
export function buildHwToConnMap(phys) {
    return Object.fromEntries(
        Object.entries(buildConnToHwMap(phys)).map(([conn, hwSig]) => [hwSig, conn])
    );
}

function getActiveMode(modes) {
    const current = modes.find(m => m[6] && m[6]['is-current']);
    if (current) return current[0];
    const preferred = modes.find(m => m[6] && m[6]['is-preferred']);
    return preferred ? preferred[0] : (modes.length ? modes[0][0] : "");
}

// hw_sig of the primary monitor, on both the live desktop and the saved profile
function resolvePrimaryHwSigs(logical, profile, connToHw) {
    const livePrimary = logical.find(lm => lm[4] && lm[5].length > 0);
    const profilePrimary = profile.logical_monitors.find(slm => slm.primary && slm.monitors.length > 0);
    return {
        livePrimaryHwSig: livePrimary ? connToHw[livePrimary[5][0][0]] : null,
        profilePrimaryHwSig: profilePrimary ? profilePrimary.monitors[0].hw_sig : null,
    };
}

// normalizes coordinates and the primary flag, then applies via D-Bus
async function applyLayoutToDBus(serial, logicalMonitors, livePrimaryHwSig, profilePrimaryHwSig) {
    if (!logicalMonitors || logicalMonitors.length === 0) throw new Error("No logical monitors to apply.");

    const lmList = logicalMonitors.map(lm => [lm[0], lm[1], lm[2], lm[3], false, lm[5], lm[6]]);
    let primaryIndex = -1;

    if (profilePrimaryHwSig) primaryIndex = lmList.findIndex(lm => lm[6] && lm[6].includes(profilePrimaryHwSig));
    if (primaryIndex === -1 && livePrimaryHwSig) primaryIndex = lmList.findIndex(lm => lm[6] && lm[6].includes(livePrimaryHwSig));
    if (primaryIndex === -1) primaryIndex = 0;

    lmList[primaryIndex][4] = true;

    const minX = Math.min(...lmList.map(lm => lm[0]));
    const minY = Math.min(...lmList.map(lm => lm[1]));
    lmList.forEach(lm => {
        lm[0] -= minX;
        lm[1] -= minY;
    });

    // Mutter's ApplyMonitorsConfig rejects the trailing properties dict that
    // GetCurrentState returns, so it's stripped down to 6 fields per monitor here
    const finalLm = lmList.map(lm => [
        Number(lm[0]), Number(lm[1]), Number(lm[2]), Number(lm[3]), lm[4],
        lm[5].map(m => [m[0], m[1], m[2] || {}])
    ]);

    const variant = new GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})", [Number(serial), 3, finalLm, {}]);
    await callMutterAsync("ApplyMonitorsConfig", variant);
}

export async function saveLayout(name, aliasResolver) {
    const [, phys, logical] = await getCurrentDisplayStateAsync();
    const connToHw = buildConnToHwMap(phys);
    const activeModes = Object.fromEntries(phys.map(p => [connToHw[p[0][0]], getActiveMode(p[1])]));
    const labels = {};
    const savedLogical = [];

    for (let idx = 0; idx < logical.length; idx++) {
        const [x, y, scale, transform, primary, physList] = logical[idx];
        const savedPhys = [];

        for (const p of physList) {
            const hwSig = connToHw[p[0]];
            savedPhys.push({ hw_sig: hwSig, mode_id: activeModes[hwSig] || "", props: {} });
            labels[await aliasResolver(p[0], p[1], p[2], x, y, String(idx + 1))] = hwSig;
        }
        savedLogical.push({ x, y, scale, transform, primary, monitors: savedPhys });
    }

    const profile = { name, labels, logical_monitors: savedLogical };
    await writeTextFileAsync(`${CONFIG_DIR}/${name}.json`, JSON.stringify(profile, null, 2));
    await writeTextFileAsync(ACTIVE_PROFILE_FILE, name);
}

export async function applyLayout(name) {
    const content = await readTextFileAsync(`${CONFIG_DIR}/${name}.json`);
    if (!content) throw new Error(`Profile '${name}' does not exist.`);

    let profile;
    try {
        profile = JSON.parse(content);
    } catch (err) {
        throw new Error(`Profile '${name}' has a corrupted configuration file.`);
    }

    const [serial, phys, logical] = await getCurrentDisplayStateAsync();
    const connToHw = buildConnToHwMap(phys);
    const { livePrimaryHwSig, profilePrimaryHwSig } = resolvePrimaryHwSigs(logical, profile, connToHw);
    const hwToConn = buildHwToConnMap(phys);
    const newLogical = [];

    for (const slm of profile.logical_monitors) {
        const monitorsArray = [], lmHwSigs = [];
        for (const sm of slm.monitors) {
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

    const content = await readTextFileAsync(`${CONFIG_DIR}/${activeName}.json`);
    if (!content) throw new Error(`Profile '${activeName}' missing.`);

    let profile;
    try {
        profile = JSON.parse(content);
    } catch (err) {
        throw new Error(`Profile '${activeName}' has a corrupted configuration file.`);
    }

    const [serial, phys, logical] = await getCurrentDisplayStateAsync();
    const hwToConn = buildHwToConnMap(phys);
    const connToHw = buildConnToHwMap(phys);
    const { livePrimaryHwSig, profilePrimaryHwSig } = resolvePrimaryHwSigs(logical, profile, connToHw);

    const desiredHws = new Set(logical.flatMap(lm => lm[5].map(p => connToHw[p[0]])));
    const toggleStates = [];

    for (const alias of aliases) {
        const targetHwSig = profile.labels?.[alias];
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

    const newLogical = [];
    for (const slm of profile.logical_monitors) {
        const keptMons = [], lmHwSigs = [];
        for (const sm of slm.monitors) {
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