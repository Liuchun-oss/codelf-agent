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
export const DESKTOP_KEY_NAME = 'DesktopKey'
export const DESKTOP_SCREENSHOT_NAME = 'DesktopScreenshot'
export const DESKTOP_SCREENSHOT_SCREEN_NAME = 'DesktopScreenshotScreen'
export const DESKTOP_SCREEN_CLICK_NAME = 'DesktopScreenClick'
export const DESKTOP_WAIT_FOR_NAME = 'DesktopWaitFor'
export const DESKTOP_HANDOFF_NAME = 'DesktopHandoff'
export const DESKTOP_CLOSE_APP_NAME = 'DesktopCloseApp'
export const ENTER_DESKTOP_TAKEOVER_NAME = 'EnterDesktopTakeover'
export const EXIT_DESKTOP_TAKEOVER_NAME = 'ExitDesktopTakeover'

export const DESKTOP_LAUNCH_APP_DESCRIPTION = `Launch a local desktop application and return its process id and session id.

Use this to start controlling the computer: opening an installed program so you can later inspect its windows, click controls, type text, or screenshot it.

Behavior:
- Windows: launches via Start-Process. "app" can be an executable name on PATH (e.g. "notepad"), a full path, or an app registered name.
- macOS: launches via "open -a". "app" is the application name (e.g. "TextEdit") or a path.
- Returns a sessionId that subsequent Desktop* tools require, plus the launched processId.

Usage:
- Call this (or DesktopGetWindow) first. Keep the sessionId for follow-up calls.
- "args" (optional) are extra command-line arguments.
- Requires OS permission; on macOS the user must grant Accessibility (and Screen Recording for screenshots).

Computer-control workflow (observe → think → act → observe). Follow this loop on every step:
1. OBSERVE: read the current state. On the FIRST step take a screenshot (DesktopScreenshot for a window, or DesktopScreenshotScreen for the whole screen) and/or DesktopSnapshot. On LATER steps do NOT take a new screenshot first — the action tool from the previous step already auto-returned a fresh screenshot of the target window; reuse that as your observation.
2. THINK: decide the single next action from what you actually see — never assume the result of a previous action.
3. ACT: perform exactly one action (DesktopClick/DesktopType/DesktopKey/DesktopMouse/DesktopDrag/DesktopScroll/DesktopScreenClick).
4. OBSERVE again: the action tools auto-return a fresh screenshot of the target window; read THAT returned image to verify the action worked before the next step — do NOT call DesktopScreenshot again just to look, it would duplicate the image and waste tokens. Only take an extra screenshot when you genuinely need something the auto-returned one cannot show (e.g. a different window, the full screen, or a popup outside the target window). If the result is wrong, re-snapshot/adjust (e.g. retry a virtual click with mode:"real").
Repeat until the goal is done. Prefer accessibility refs (DesktopSnapshot + DesktopClick/DesktopType) over raw coordinates when a ref exists; fall back to coordinates/screen clicks for canvases, custom UIs, or Chromium/Electron windows.`

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
- When available, the result starts with high-signal context lines you should read first: "Focused:" (the currently focused control), "Selected text:" (highlighted text), and "Document text:" (the focused editor/field's content). Check these before scanning the control list — they often answer "where is the cursor / what is selected / what's in the box".
- Then a list of controls; each line has a stable ref like [ref=n12] or a semantic [ref=a:chat_input_field], its role, name, and flags. Leading indentation reflects the nesting depth in the UI tree (a child is indented under its container), so you can tell which controls belong to which panel/group. Flags: "actionable" (clickable), "editable" (accepts text), "disabled" (greyed out — clicking usually has no effect, satisfy its precondition first, e.g. type content before a disabled Send button enables). When available, @(x,y) gives the control's client-area center coordinate.
- Pass the bare ref (e.g. "n12" or "a:chat_input_field") to DesktopClick or DesktopType. Refs starting with "a:" are stable platform AutomationIds and remain valid even if the layout shifts; plain "n" refs are positional and can drift, so re-snapshot if the tree changed. Pass the @(x,y) coordinate to DesktopMouse/DesktopDrag for free-form clicking or dragging.
- This is read-only and a point-in-time snapshot, NOT a live view. Treat it as expensive: snapshot once, batch several actions, then snapshot again only to verify or after the layout/focus/modality likely changed.`

export const DESKTOP_CLICK_DESCRIPTION = `Click a control inside a window.

Usage:
- "windowId" from DesktopGetWindow and "ref" from DesktopSnapshot.
- Prefers accessibility invoke/toggle; falls back to a coordinate click when no pattern is available.
- Run DesktopSnapshot first to get a fresh ref.`

export const DESKTOP_TYPE_DESCRIPTION = `Type text into an editable control inside a window.

Usage:
- "windowId" from DesktopGetWindow, "ref" from DesktopSnapshot, "text" is the content.
- Prefers setting the control value directly; falls back to focusing and sending keystrokes.
- "submit" (optional) presses Enter after typing.
- "mode" (optional): "auto" (default) sets the value directly then falls back to keystrokes — fast and reliable for most fields. "realKeystroke" focuses the control and types character-by-character with real keyboard events (Unicode-aware); slower, but use it when "auto" appears to fill the field yet the app does not react (rich-text/contenteditable editors, fields with live validation or input-method composition, some Electron/web inputs), or when an input blocks programmatic value-setting.`

export const DESKTOP_MOUSE_DESCRIPTION = `Click at an arbitrary coordinate inside a window (not tied to an accessibility ref).

Use this for free-form clicking when DesktopSnapshot has no usable control ref: canvases, custom-drawn UIs, maps, games, image editors.

Coordinates:
- "x"/"y" are pixels relative to the TARGET WINDOW's client area (top-left = 0,0), not the whole screen.
- By default you can pass the pixel coordinates you read directly off the most recent DesktopScreenshot of this window — even if that screenshot was downscaled. The tool auto-maps them back using the screenshot's scale. Set "coordinateSpace":"client" if you already have true client-area pixels (e.g. from DesktopSnapshot @(x,y)).
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
- Like DesktopMouse, by default you may pass coordinates read off the latest (possibly downscaled) DesktopScreenshot; set "coordinateSpace":"client" to pass true client pixels.
- "button": "left" (default), "right", "middle".
- "steps" (optional, default 20): number of intermediate move events; increase for apps that need smooth motion to recognize the drag.
- "mode": "virtual" (default) or "real". If a virtual drag does not register, retry with "real".`

export const DESKTOP_SCROLL_DESCRIPTION = `Scroll the mouse wheel over a coordinate inside a window.

Usage:
- "x"/"y" are client-area-relative pixels (the point to scroll over); image-space coordinates from the latest DesktopScreenshot are accepted by default (set "coordinateSpace":"client" to override).
- "deltaY": vertical ticks, positive scrolls DOWN, negative scrolls UP.
- "deltaX" (optional): horizontal ticks, positive scrolls RIGHT.
- "mode": "virtual" (default) or "real".`

export const DESKTOP_KEY_DESCRIPTION = `Send a keyboard key or key combination to the focused window (global keystroke, not tied to a control).

Use this for shortcuts and special keys that DesktopType cannot express: copy/paste, save, undo, navigation, function keys, Enter/Tab/Esc, arrow keys, etc.

Usage:
- "combo" is a "+"-joined chord, case-insensitive. Modifiers: ctrl, alt, shift, win/cmd. Examples: "ctrl+c", "ctrl+v", "ctrl+s", "alt+tab", "enter", "esc", "tab", "f5", "ctrl+shift+esc", "up".
- Special key names: enter/return, esc/escape, tab, space, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1..f12.
- The target window is brought to front first. On macOS the "win" modifier maps to Command.
- "windowId" selects the target window; "mode" mirrors the mouse tools.
- To type literal text into a field, use DesktopType instead.`

export const DESKTOP_SCREENSHOT_DESCRIPTION = `Take a screenshot of a specific window and embed it for inline preview.

The image is also sent to the model ONLY when the active model has image input (vision) enabled; otherwise a text placeholder is kept.

Usage:
- "windowId" comes from DesktopGetWindow.
- "maxDimension" (optional) caps the screenshot's longest side in pixels and downscales to it, lowering vision-token cost (e.g. 1280). Coordinates you read off the downscaled image can be passed straight to DesktopMouse/DesktopDrag/DesktopScroll — they auto-map back to true client pixels.
- macOS requires Screen Recording permission.
- This is read-only.`

export const DESKTOP_SCREENSHOT_SCREEN_DESCRIPTION = `Take a screenshot of the WHOLE screen (all monitors or the primary one), not tied to any window. Use for global reconnaissance: locating pop-ups/dialogs/notifications, the taskbar/menu bar, the desktop, or windows you have not registered yet.

The image is sent to the model ONLY when the active model has image input (vision) enabled; otherwise a text placeholder is kept.

Usage:
- "sessionId" is required (create one via DesktopGetWindow/DesktopLaunchApp). No windowId needed.
- "area": "virtual" (default, the full multi-monitor virtual desktop) or "primary" (primary monitor only).
- "maxDimension" (optional) caps the longest side in pixels and downscales (e.g. 1280) to lower vision-token cost.
- Pixel coordinates you read off this screenshot can be passed straight to DesktopScreenClick — they auto-map back to true screen pixels.
- To act inside a specific window, prefer the window-scoped tools (DesktopScreenshot + DesktopSnapshot/Click). Use this + DesktopScreenClick only for free-form, screen-global clicking.
- macOS requires Screen Recording permission. This is read-only.`

export const DESKTOP_SCREEN_CLICK_DESCRIPTION = `Click at an absolute SCREEN coordinate (not relative to any window). Always uses real input (moves the actual cursor), so it works on any window including Chromium/Electron apps.

Use together with DesktopScreenshotScreen for screen-global clicking: read the target pixel off the latest full-screen screenshot and pass it here.

Coordinates:
- "x"/"y" are pixels off the latest DesktopScreenshotScreen by default; the tool auto-maps them back to true screen pixels using that screenshot's scale/origin. Set "coordinateSpace":"screen" if you already have true physical screen pixels.

Behavior:
- "button": "left" (default), "right", "middle". "doubleClick": true performs a double click.
- This moves the real cursor and clicks wherever it lands — make sure the coordinate is correct (re-screenshot to verify).`

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

export const ENTER_DESKTOP_TAKEOVER_DESCRIPTION = `Enter full-screen takeover mode before you start operating the user's computer with the Desktop* tools.

When to use this AUTONOMOUSLY (decide yourself, do not wait to be asked):
- The user's request can only be fulfilled by operating GUI applications on their computer (clicking, typing, navigating apps, filling forms, automating a desktop workflow) rather than by answering, writing code, or editing files.
- Examples: "help me open X and do Y", "fill in this form in app Z", "organize these windows", "click through this installer".

What it does:
- Minimizes the codelf window to the tray, shows a corner HUD (your live progress + an ESC-to-exit hint) and a screen-edge marquee so the user clearly sees the computer is being controlled.
- After entering, use the Desktop* tools (DesktopScreenshotScreen, DesktopGetWindow, DesktopSnapshot, DesktopClick, DesktopType, DesktopScreenClick, etc.) in an observe->act->observe loop.
- While in takeover, DesktopGetWindow automatically restores and brings the target window to the foreground, so the user can watch what you do. Keep the target window visible: do not minimize it; if you must switch apps, bring the next one to front via DesktopGetWindow.
- When the task is done OR you cannot make progress, call ExitDesktopTakeover to hand control back and restore the codelf window, then summarize the outcome.

Notes:
- "task" (optional): a short label of what you are about to do, shown on the HUD.
- Do NOT enter takeover for pure Q&A, coding, file edits, or web/browser-only tasks (use Browser* tools for the latter).
- The user can interrupt anytime with ESC or the HUD stop button; if that happens your turn is cancelled.`

export const EXIT_DESKTOP_TAKEOVER_DESCRIPTION = `Exit full-screen takeover mode and restore the codelf window.

Call this as soon as the desktop task is complete, or when you have determined you cannot complete it. After calling, continue your reply normally (e.g. summarize what you did or why you stopped).

Usage:
- "summary" (optional): a one-line result shown briefly on the HUD before it closes.
- Safe to call even if not currently in takeover (no-op).`
