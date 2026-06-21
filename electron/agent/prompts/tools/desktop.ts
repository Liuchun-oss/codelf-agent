export const DESKTOP_LAUNCH_APP_NAME = 'DesktopLaunchApp'
export const DESKTOP_LIST_WINDOWS_NAME = 'DesktopListWindows'
export const DESKTOP_GET_WINDOW_NAME = 'DesktopGetWindow'
export const DESKTOP_SNAPSHOT_NAME = 'DesktopSnapshot'
export const DESKTOP_CLICK_NAME = 'DesktopClick'
export const DESKTOP_TYPE_NAME = 'DesktopType'
export const DESKTOP_MOUSE_NAME = 'DesktopMouse'
export const DESKTOP_MOUSE_MOVE_NAME = 'DesktopMouseMove'
export const DESKTOP_DRAG_NAME = 'DesktopDrag'
export const DESKTOP_SCROLL_NAME = 'DesktopScroll'
export const DESKTOP_SCREENSHOT_NAME = 'DesktopScreenshot'
export const DESKTOP_WAIT_FOR_NAME = 'DesktopWaitFor'
export const DESKTOP_HANDOFF_NAME = 'DesktopHandoff'
export const DESKTOP_CLOSE_APP_NAME = 'DesktopCloseApp'

export const DESKTOP_LAUNCH_APP_DESCRIPTION = `Launch a local desktop application and return its process id and session id.

Use this to start controlling the computer: opening an installed program so you can later inspect its windows, click controls, type text, or screenshot it.

Behavior:
- Windows: launches via Start-Process. "app" can be an executable name on PATH (e.g. "notepad"), a full path, or an app registered name.
- macOS: launches via "open -a". "app" is the application name (e.g. "TextEdit") or a path.
- Returns a sessionId that subsequent Desktop* tools require, plus the launched processId.

Usage:
- Call this (or DesktopGetWindow) first. Keep the sessionId for follow-up calls.
- "args" (optional) are extra command-line arguments.
- Requires OS permission; on macOS the user must grant Accessibility (and Screen Recording for screenshots).`

export const DESKTOP_LIST_WINDOWS_DESCRIPTION = `List currently visible top-level windows (title, owning process, process id, and a native handle).

Usage:
- "sessionId" comes from DesktopLaunchApp or DesktopGetWindow. If omitted, a session is created and returned.
- Use the returned info to pick a target window for DesktopGetWindow.
- This is read-only.`

export const DESKTOP_GET_WINDOW_DESCRIPTION = `Locate a single window by title substring, process name, or native handle and register it for control.

Usage:
- Provide at least one of "title" (case-insensitive substring), "processName", or "nativeHandle".
- Returns a stable "windowId" used by DesktopSnapshot/Click/Type/Screenshot.
- "sessionId" is optional; a new session is created and returned when omitted.`

export const DESKTOP_SNAPSHOT_DESCRIPTION = `Capture a structured snapshot of a window's UI components (accessibility tree) so you can locate controls before acting.

Use this to understand a window's structure and find elements to click or fill, similar to a browser accessibility snapshot.

Usage:
- "windowId" comes from DesktopGetWindow.
- Returns a list of controls; each line has a stable ref like [ref=n12], its role, name, and whether it is actionable/editable. When available, @(x,y) gives the control's client-area center coordinate.
- Pass the bare ref (e.g. "n12") to DesktopClick or DesktopType. Pass the @(x,y) coordinate to DesktopMouse/DesktopDrag for free-form clicking or dragging.
- This is read-only.`

export const DESKTOP_CLICK_DESCRIPTION = `Click a control inside a window.

Usage:
- "windowId" from DesktopGetWindow and "ref" from DesktopSnapshot.
- Prefers accessibility invoke/toggle; falls back to a coordinate click when no pattern is available.
- Run DesktopSnapshot first to get a fresh ref.`

export const DESKTOP_TYPE_DESCRIPTION = `Type text into an editable control inside a window.

Usage:
- "windowId" from DesktopGetWindow, "ref" from DesktopSnapshot, "text" is the content.
- Prefers setting the control value directly; falls back to focusing and sending keystrokes.
- "submit" (optional) presses Enter after typing.`

export const DESKTOP_MOUSE_DESCRIPTION = `Click at an arbitrary coordinate inside a window (not tied to an accessibility ref).

Use this for free-form clicking when DesktopSnapshot has no usable control ref: canvases, custom-drawn UIs, maps, games, image editors.

Coordinates:
- "x"/"y" are pixels relative to the TARGET WINDOW's client area (top-left = 0,0), not the whole screen.
- Tip: DesktopSnapshot exposes control bounds you can aim at; or use DesktopScreenshot to eyeball a position.

Behavior:
- "button": "left" (default), "right", or "middle".
- "doubleClick": true performs a double click.
- "mode": "virtual" (default, injects window messages WITHOUT moving the real cursor, so the user is not disturbed), "real" (moves the actual system cursor; best compatibility), or "auto".
- Virtual mode may be ignored by some apps (Chromium/Electron, DirectX games, raw-input apps). If a virtual click has no effect, retry with "mode":"real".`

export const DESKTOP_MOUSE_MOVE_DESCRIPTION = `Move the mouse pointer to a coordinate inside a window (e.g. to hover and reveal tooltips or hover menus).

Usage:
- "x"/"y" are client-area-relative pixels (see DesktopMouse).
- "mode": "virtual" (default, does not move the real cursor) or "real".`

export const DESKTOP_DRAG_DESCRIPTION = `Press the mouse button at one coordinate, move to another, and release — i.e. a drag/drop or selection.

Use for: dragging a slider, selecting a text/region range, moving a file/icon, reordering list items, drawing.

Usage:
- "fromX"/"fromY" is the start, "toX"/"toY" the end — all client-area-relative pixels (see DesktopMouse).
- "button": "left" (default), "right", "middle".
- "steps" (optional, default 20): number of intermediate move events; increase for apps that need smooth motion to recognize the drag.
- "mode": "virtual" (default) or "real". If a virtual drag does not register, retry with "real".`

export const DESKTOP_SCROLL_DESCRIPTION = `Scroll the mouse wheel over a coordinate inside a window.

Usage:
- "x"/"y" are client-area-relative pixels (the point to scroll over).
- "deltaY": vertical ticks, positive scrolls DOWN, negative scrolls UP.
- "deltaX" (optional): horizontal ticks, positive scrolls RIGHT.
- "mode": "virtual" (default) or "real".`

export const DESKTOP_SCREENSHOT_DESCRIPTION = `Take a screenshot of a specific window and embed it for inline preview.

The image is also sent to the model ONLY when the active model has image input (vision) enabled; otherwise a text placeholder is kept.

Usage:
- "windowId" comes from DesktopGetWindow.
- macOS requires Screen Recording permission.
- This is read-only.`

export const DESKTOP_WAIT_FOR_DESCRIPTION = `Wait for a window matching a title/process to appear before continuing.

Usage:
- Provide "title" (substring) and/or "processName".
- "timeoutMs" caps the wait (default 15000).
- Returns the matched window info, or an error on timeout.`

export const DESKTOP_HANDOFF_DESCRIPTION = `Hand control of the computer to the user, pausing automation until they confirm completion.

Use this when a step requires a human: entering a password, completing a login, accepting a dialog, or any manual interaction the agent should not perform.

Behavior:
- Screenshots the target window (when available), then asks the user to act in the visible window.
- BLOCKS until the user confirms they are done (or cancels).

Usage:
- "windowId" (optional) selects which window to preview.
- "message" explains exactly what the user should do.`

export const DESKTOP_CLOSE_APP_DESCRIPTION = `Close a running application gracefully, or force-kill it.

Usage:
- Provide "processId" (from DesktopLaunchApp) or "windowId" (from DesktopGetWindow).
- "force" (optional) kills the process immediately instead of requesting a graceful close.
- This is destructive: closing an app may discard unsaved work.`
