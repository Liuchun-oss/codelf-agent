export const BROWSER_OPEN_NAME = 'BrowserOpen'
export const BROWSER_NAVIGATE_NAME = 'BrowserNavigate'
export const BROWSER_CLICK_NAME = 'BrowserClick'
export const BROWSER_TYPE_NAME = 'BrowserType'
export const BROWSER_SNAPSHOT_NAME = 'BrowserSnapshot'
export const BROWSER_GET_CONTENT_NAME = 'BrowserGetContent'
export const BROWSER_SCREENSHOT_NAME = 'BrowserScreenshot'
export const BROWSER_WAIT_FOR_NAME = 'BrowserWaitFor'
export const BROWSER_HANDOFF_NAME = 'BrowserHandoff'
export const BROWSER_TABS_NAME = 'BrowserTabs'
export const BROWSER_COOKIES_NAME = 'BrowserCookies'
export const BROWSER_CLOSE_NAME = 'BrowserClose'

export const BROWSER_OPEN_DESCRIPTION = `Open a real, visible Chromium browser session controlled via Playwright and return a sessionId.

Use this to start browser automation: navigating sites, clicking, typing, reading rendered content, or completing flows that require a real browser (JavaScript-heavy pages, logins, captchas).

Behavior:
- Launches a headed (visible) Chromium window so the user can watch and, when needed, take over manually.
- Optionally navigates to "url" on open.
- Returns a sessionId that ALL other Browser* tools require.

Usage:
- Call this first. Keep the sessionId and pass it to subsequent Browser* calls.
- Prefer BrowserSnapshot to discover clickable elements before BrowserClick.
- Always call BrowserClose when finished to release the browser process.`

export const BROWSER_NAVIGATE_DESCRIPTION = `Navigate an existing browser session to a URL and wait for it to load.

Usage:
- "sessionId" comes from BrowserOpen.
- "url" must be a fully-qualified http/https URL (internal/loopback addresses are rejected).
- "waitUntil" controls load completion: 'load' | 'domcontentloaded' | 'networkidle' (default 'load').
- Returns the resulting URL and page title.`

export const BROWSER_CLICK_DESCRIPTION = `Click an element in the browser session.

Usage:
- Provide either "selector" (CSS selector) or "ref" (a bare element ref like "e3" from BrowserSnapshot, without brackets).
- Prefer running BrowserSnapshot first to get a stable ref for the target.
- Returns the resulting URL/title after the click settles.`

export const BROWSER_TYPE_DESCRIPTION = `Type text into an input element in the browser session.

Usage:
- "selector" is a CSS selector for the input/textarea.
- "text" is the string to fill.
- "submit" (optional) presses Enter after typing to submit the form.
- The field is cleared before typing.`

export const BROWSER_SNAPSHOT_DESCRIPTION = `Capture a compact, structured snapshot of the page's interactive elements (accessibility tree) for the browser session.

Use this to understand page structure and locate elements before clicking or typing.

Usage:
- Returns a list of interactive elements; each line ends with a stable ref like [ref=e3].
- Pass the bare ref value (e.g. "e3", without brackets) as "ref" to BrowserClick to act on that exact element.
- This is read-only and does not change the page.`

export const BROWSER_GET_CONTENT_DESCRIPTION = `Get the current page's content from the browser session.

Usage:
- "format" = 'html' returns the rendered page HTML source; 'text' returns readable text (tags stripped).
- Large content is truncated.
- This is read-only.`

export const BROWSER_SCREENSHOT_DESCRIPTION = `Take a screenshot of the current page in the browser session and save it to a temporary file.

Usage:
- "fullPage" (optional) captures the entire scrollable page instead of just the viewport.
- The result embeds the image so it can be previewed inline.
- This is read-only.`

export const BROWSER_WAIT_FOR_DESCRIPTION = `Wait for a condition in the browser session before continuing.

Usage:
- Provide "selector" with "state" ('visible' | 'hidden' | 'attached' | 'detached') to wait for an element.
- Omit "selector" to wait for network idle.
- "timeoutMs" caps the wait (default 15000).`

export const BROWSER_HANDOFF_DESCRIPTION = `Hand control of the browser to the user, pausing automation until they confirm completion.

Use this when a step requires a human: solving a captcha, completing a login, accepting a consent dialog, or any manual interaction the agent cannot or should not perform.

Behavior:
- Takes a screenshot, then asks the user to act in the visible browser window.
- BLOCKS until the user confirms they are done (or cancels).
- After the user confirms, returns the latest URL/title so you can continue automating.

Usage:
- "message" explains exactly what the user should do in the browser window.
- Do NOT use this for decisions answerable by text questions; use it specifically to transfer hands-on browser control.`

export const BROWSER_TABS_DESCRIPTION = `Manage tabs (pages) within the browser session.

Usage:
- "action" = 'list' lists open tabs with their index, URL, and title.
- 'new' opens a new tab (optionally at "url") and makes it active.
- 'select' switches the active tab to "index".
- 'close' closes the tab at "index".`

export const BROWSER_COOKIES_DESCRIPTION = `Inspect or clear cookies for the browser session.

Usage:
- "action" = 'get' returns the current cookies (names, domains, values).
- 'clear' removes all cookies in the session context.
- Use 'clear' to reset login/session state.`

export const BROWSER_CLOSE_DESCRIPTION = `Close a browser session and release its resources.

Usage:
- "sessionId" comes from BrowserOpen.
- Always call this when you are done with browser automation.
- After closing, the sessionId is no longer valid.`
