# Display Layouts Manager

A native GNOME Shell extension to save, toggle, cycle, and auto-apply multi-monitor configurations via the top panel, global shortcuts, or system D-Bus.

---

## Features

* **Top Panel Dropdown Menu:** Apply profiles, toggle individual screens, or save layouts with a single click.
* **Profile Groups & Subprofiles:** Organize monitor arrangements hierarchically (e.g. `Work:dual`, `Work:single`).
* **Hardware Auto-Apply:** Detects physical hardware signatures (`Vendor_Model_Serial`) to auto-apply saved defaults when plugging into docking stations or external monitors.
* **8-Slot Global Hotkeys:** Configure shortcuts in preferences to `Apply Profile`, `Toggle Display`, `Save State`, or `Cycle Subprofiles`.
* **Process-Safe Asynchronous D-Bus:** Uses non-blocking async D-Bus calls to eliminate shell lockups and deadlocks.
* **Self-Healing Layout Engine:** Automatically shifts bounding-box coordinates to `(0,0)` and sanitizes Mutter variants.

---

## Quick Start

### 1. Installation

```bash
# Save extension files into local extension directory
mkdir -p ~/.local/share/gnome-shell/extensions/display-layouts@gnome-monitor-layouts.local
cp -r * ~/.local/share/gnome-shell/extensions/display-layouts@gnome-monitor-layouts.local/

# Compile GSettings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/display-layouts@gnome-monitor-layouts.local/schemas/

# Enable extension
gnome-extensions enable display-layouts@gnome-monitor-layouts.local
```

*Note: Restart GNOME Shell after enabling (Log out/in on Wayland, or press `Alt + F2`, type `r`, and press `Enter` on X11).*

### 2. Saving & Managing Layouts

1. Arrange monitors, scaling, and rotation in GNOME **Display Settings**.
2. Click the top panel indicator icon and select **Save Current Layout...**.
3. Set a **Group Name** (e.g. `Work`, `Home`), a **Subprofile Name** (e.g. `dual`, `single`), and optional monitor text aliases (e.g. `left`, `right`, `tv`).
4. Check **Set as default subprofile for this hardware** if you want this profile automatically applied when this monitor topology is connected.

### 3. Applying & Toggling

* Click any profile in the panel menu to apply it.
* Toggle individual active screens on or off under the **Toggle Displays** section.

---

## Global Keyboard Shortcuts

Open extension preferences (`gnome-extensions prefs display-layouts@gnome-monitor-layouts.local`) to configure up to **8 Custom Slots**:

| Action | Target Name | Description |
| :--- | :--- | :--- |
| **Apply Profile** | Profile or Group:Subprofile name (e.g., `Work:dual`) | Applies target layout instantly. |
| **Toggle Display** | Display alias (e.g., `tv`, `left`) | Toggles specific screen on or off within active setup. |
| **Save State** | *(Ignored)* | Opens interactive layout save dialog. |
| **Cycle Subprofiles** | *(Ignored)* | Cycles through available subprofiles for active hardware set. |

*Shortcut String Example Syntax:* `<Super>1`, `<Super><Shift>t`, `<Ctrl><Alt>h`

---

## Terminal D-Bus API

The extension exposes a native D-Bus interface for command-line control and automation scripts.

* **Service:** `org.gnome.Shell`
* **Object Path:** `/org/gnome/Shell/Extensions/DisplayLayouts`
* **Interface:** `org.gnome.Shell.Extensions.DisplayLayouts`

### 1. Apply Layout
```bash
gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
  --method org.gnome.Shell.Extensions.DisplayLayouts.Apply \
  "Work:dual"
```

### 2. Toggle Screen
```bash
gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
  --method org.gnome.Shell.Extensions.DisplayLayouts.Toggle \
  "['left']"
```

### 3. Cycle Active Subprofiles
```bash
gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
  --method org.gnome.Shell.Extensions.DisplayLayouts.Cycle
```

### 4. Trigger Interactive Save Dialog
```bash
gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/DisplayLayouts \
  --method org.gnome.Shell.Extensions.DisplayLayouts.Save \
  "Work"
```

---

## Architecture & Developer Reference

### File Architecture

* `extension.js`: Primary extension entry point. Handles indicator lifecycle, D-Bus service export, global keybindings, and Mutter `MonitorsChanged` event tracking.
* `layoutEngine.js`: Core layout engine. Manages hardware signature hashing, file serialization (`~/.config/display-layouts/`), coordinate math, and async Mutter D-Bus calls.
* `dialogs.js`: St/Clutter modal dialog (`SaveLayoutDialog`) for profile naming, group selections, and screen alias mapping.
* `prefs.js`: Libadwaita GTK4 preferences window for 8 hotkey slots, notifications, and panel icon visibility settings.
* `schemas/`: Houses `org.gnome.shell.extensions.display-layouts.gschema.xml` and compiled `gschemas.compiled`.
* `metadata.json`: Extension identifier UUID and target GNOME Shell version compatibility array.

### Technical Mechanics

1. **Non-Blocking Mutter IPC**: GNOME Shell and Mutter run single-threaded in one process. Synchronous proxy calls (`_sync`) block the main event loop and freeze the shell. All Mutter calls use asynchronous invocation (`Gio.DBus.session.call`).
2. **Event-Driven Cache & Synchronous UI**: Rebuilding dynamic menus asynchronously while visible triggers Clutter layout allocation loops and CPU spikes. Current state is cached asynchronously on Mutter's `MonitorsChanged` signal; panel menus render 100% synchronously from memory when opened.
3. **Bounding Box Coordinate Normalization**: Mutter throws `Logical monitors positions are offset` if the top-left coordinate of the active monitor bounding box is non-zero. The engine automatically offsets all coordinates back by `(min_x, min_y)` before calling `ApplyMonitorsConfig`.
4. **D-Bus Variant Sanitization**: Mutter's `GetCurrentState` returns logical monitor structures containing trailing properties dictionaries `(iiduba(s)a{sv})`, but `ApplyMonitorsConfig` strictly expects `(uua(iiduba(ssa{sv}))a{sv})`. The engine explicitly sanitizes variants during packing.
