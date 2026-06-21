const IS_WIN = process.platform === 'win32'
const SHELL_LABEL = IS_WIN ? 'Windows PowerShell' : 'shell (bash/zsh)'

export const START_TERMINAL_TASK_NAME = 'StartTerminalTask'
export const READ_TERMINAL_TASK_NAME = 'ReadTerminalTask'
export const STOP_TERMINAL_TASK_NAME = 'StopTerminalTask'
export const WRITE_TERMINAL_TASK_NAME = 'WriteTerminalTask'

export const START_TERMINAL_TASK_DESCRIPTION = `Start a ${SHELL_LABEL} command as a BACKGROUND task and return a task id immediately (does not wait for completion).

Use this instead of run_terminal_cmd/PowerShell when:
- The command keeps running and won't exit on its own: dev servers, watchers, \`tail -f\`.
- It's a long build/test and you want to keep working while it runs.
- It is slow but WILL eventually finish: large file downloads, SDK/runtime installs (Flutter, Android SDK, JDK), package installs (npm/pip/cargo), \`git clone\` of big repos. Do NOT run these in the foreground with a huge timeout_ms — background them here and poll with ReadTerminalTask, so a slow network doesn't block the whole turn.
- It prompts for input you must answer at runtime (then use ReadTerminalTask + WriteTerminalTask).
For a quick command where you just need the result, prefer run_terminal_cmd instead.

Usage:
- "command": a ${SHELL_LABEL} command. "working_directory" (optional): workspace-relative. Don't add \`&\`; the tool backgrounds it.
- Then use ReadTerminalTask (inspect output/status), WriteTerminalTask (answer prompts), StopTerminalTask (terminate). Don't poll without reason.`

export const READ_TERMINAL_TASK_DESCRIPTION = `Read the status and buffered stdout/stderr of a background task started by StartTerminalTask.

Use this to check whether a task started, reached steady state, is waiting on a prompt, failed, or finished.
- "task_id": id from StartTerminalTask. Returns status, cwd, command, exit code (when available), stderr, stdout (tailed for large buffers).
- Read when your next step depends on the task state — not as a blind polling loop.`

export const STOP_TERMINAL_TASK_DESCRIPTION = `Stop a running background task (terminates its process tree). Use to shut down a dev server/watcher you no longer need, or a task that is clearly hung.

- "task_id": id from StartTerminalTask.
- Don't stop tasks you didn't start unless the user asks or it's needed to prevent harm.`

export const WRITE_TERMINAL_TASK_DESCRIPTION = `Send input to the stdin of a running background task — the only way to answer an interactive prompt (e.g. "Continue? [y/N]", a menu choice, or a required Enter). Front-line shell tools can't be answered; if a command needs input, start it with StartTerminalTask and answer here.

Usage:
- "task_id": id from StartTerminalTask. "input": text to send. "append_newline" (optional, default true): appends Enter; set false for a single keypress.
- Read the prompt with ReadTerminalTask first, send the answer (e.g. "y"), then read again to see the result.
- Safety: only answer when the response is clearly safe. Do NOT confirm destructive actions or anything you're unsure of — ask the user instead. Never type passwords or secrets.`
