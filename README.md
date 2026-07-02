# Display Layouts Manager   

An elegant, self-contained GNOME Shell Extension to manage, save, and toggle multi-monitor display configurations natively via the top panel, keyboard shortcuts, or terminal command APIs.

---

## Features

*   **Top Panel Dropdown Menu:** Apply profiles, toggle individual screens, or save layouts with a single click.
*   **Dynamic Port Mapping:** Identifies screens by physical hardware signatures (Vendor, Model, Serial), surviving cable swaps, USB-C docking stations, or system restarts.
*   **Dynamic 8-Slot Hotkeys:** Configure any slot in preferences to instantly `Apply Profile`, `Toggle Display`, or trigger the interactive `Save State` popup.
*   **Process-Safe Asynchronous D-Bus:** Operates completely on non-blocking async D-Bus calls, preventing shell lockups and deadlocks.
*   **Self-Healing Layouts:** Automatically shifts coordinates to `(0,0)` to avoid Mutter window manager errors, and enforces sticky primary display logical flows.

---

## Quick Start (User Guide)

### 1. Installation
1. Save the extension files into your local extension directory:
   `~/.local/share/gnome-shell/extensions/display-layouts@gnome-monitor-layouts.local/`
2. Compile the GSettings database schema:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/display-layouts@gnome-monitor-layouts.local/schemas/
   ```
3. Enable the extension:
   ```bash
   gnome-extensions enable display-layouts@gnome-monitor-layouts.local
   ```
   *Note: Log out of your desktop session and log back in (Wayland) or press `Alt + F2`, type `r`, and hit `Enter` (X11) to load the files into memory.*

### 2. Saving a Layout
1. Open the system GNOME **Display Settings** and arrange your monitor layout, scaling, and orientation as desired.
2. Click the display monitor icon in your top panel to click **Save Current Layout...**
3. Enter a profile name (e.g. `home` or `office`) and assign friendly text aliases to each connected screen (e.g. `left`, `right`, `tv`).

### 3. Applying and Toggling Layouts
*   To switch entire screen configurations instantly, click any saved profile in the top dropdown list.
*   To turn individual displays on or off, check or uncheck their aliases under the **Toggle Displays** header.

---

## Keyboard Shortcuts Setup

On the extension settings you can configure up to **8 Generic Slots**:

1.  **Action Type:** Choose `Apply Profile`, `Toggle Display`, or `Save State (Prompt Dialog)`.
2.  **Target Name:** Type the profile name (e.g. `home`) or the monitor alias (e.g. `tv`). This input is ignored if `Save State` is selected.
3.  **Keyboard Shortcut String:** Type your modifier-wrapped key combinations, for example:
    *   `<Super>1`
    *   `<Super><Shift>t`
    *   `<Ctrl><Alt>h`

---

## Terminal Command API (Power Users & Scripting)

The extension exposes a self-contained system D-Bus service, allowing headless terminal integration without external helper scripts or symlinks.

### 1. Apply a Layout
```bash
gdbus call --session \
           --dest org.gnome.Shell \
           --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
           --method org.gnome.Shell.Extensions.DisplayLayouts.Apply \
           "home"
```

### 2. Toggle a Screen
```bash
gdbus call --session \
           --dest org.gnome.Shell \
           --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
           --method org.gnome.Shell.Extensions.DisplayLayouts.Toggle \
           "['left']"
```

### 3. Trigger Interactive Save Pop-up
```bash
gdbus call --session \
           --dest org.gnome.Shell \
           --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
           --method org.gnome.Shell.Extensions.DisplayLayouts.Save \
           "work"
```

---

## Developer & Maintainer Notes

This section outlines the architectural patterns and internal mechanics of the extension.

### File Architecture
*   `metadata.json`: Declares the extension UUID and target GNOME compatibility versions.
*   `extension.js`: Core entry point. Orchestrates the panel menu button lifecycle, imports GSettings, registers global hotkey bindings, and exports the native D-Bus wrapper.
*   `layoutEngine.js`: The algorithmic engine. Contains helper math, file I/O operations, and serializes GVariant parameters to communicate with Mutter.
*   `dialogs.js`: Houses the `SaveLayoutDialog` modal window implemented in Clutter and St.

### 1. Single-Threaded Deadlock Prevention
GNOME Shell and the Mutter window manager run in the **same process on the same thread**.
*   *Crucial Rule:* Making a synchronous D-Bus proxy call (`_sync`) to Mutter from inside a shell extension blocks the thread. While the extension is waiting for the D-Bus reply, Mutter is blocked and cannot process the request to send the reply, causing a **permanent or temporary deadlock/freeze**.
*   *Design Pattern:* We use **zero** DBusProxy sync wrappers. All queries and applications are direct asynchronous commands over the pre-initialized connection: `Gio.DBus.session.call()`.

### 2. State Caching & Event-Driven Rendering
A visible dropdown menu built asynchronously via `await` calls causes rendering races. If you clear a menu and yield, Clutter maps a `0x0` container. Populating items afterward forces expensive recalculations on mapped actors, causing **infinite allocation loops** and CPU spikes.
*   *Design Pattern:* The extension caches current display configurations in memory (`this._displayStateCache`).
*   It subscribes to Mutter's D-Bus signal `'MonitorsChanged'` to automatically refresh this cache asynchronously in the background.
*   When the user opens the menu, `_rebuildMenu()` executes **100% synchronously using the in-memory cache**, avoiding asynchronous rendering races entirely.

### 3. Coordinate Normalization
Mutter rejects configuration attempts with the error `Logical monitors positions are offset` if the top-leftmost coordinate in the bounding box of active screens is not strictly `(0,0)`. `layoutEngine.js` automatically shifts all coordinates back by `min_x` and `min_y` inside memory before serialization.

### 4. D-Bus Payload Asymmetry
There is an asymmetric signature difference in Mutter’s D-Bus API:
*   `GetCurrentState` returns logical monitors with a trailing properties dictionary: `(iiduba(s)a{sv})`.
*   `ApplyMonitorsConfig` strictly rejects that trailing properties element, expecting exactly 6 parameters per logical monitor: `(iiduba(ssa{sv}))`.
*   `layoutEngine.js` handles this sanitization explicitly during GVariant packing.
