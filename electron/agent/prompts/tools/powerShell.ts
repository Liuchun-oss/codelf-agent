import { APP_NAME } from '@shared/appConfig'

const IS_WIN = process.platform === 'win32'

export const POWERSHELL_NAME = 'PowerShell'

const WIN_DESCRIPTION = `Run a one-off Windows PowerShell command and wait for it to finish (UTF-8 output).

Use this instead of run_terminal_cmd ONLY when you need its extra parameters:
- "working_directory" (optional, workspace-relative): run in a subdirectory instead of the workspace root.
- "timeout_ms" (optional, capped by ${APP_NAME}): allow longer than the default 120s while still waiting for completion.
Otherwise prefer run_terminal_cmd. For commands that should keep running in the background, use StartTerminalTask instead. Do NOT use a very large timeout_ms to wait on slow-but-finishing commands (large downloads, SDK/package installs, big \`git clone\`) in the foreground — background them with StartTerminalTask and poll with ReadTerminalTask instead.

Usage:
- "command": valid Windows PowerShell syntax, not bash-only syntax (\`&&\`, \`||\`, heredocs, \`export\`, \`rm -rf\`); use \`; if ($?) { ... }\`, \`$env:VAR='value'\`, \`Remove-Item\`. Quote paths with spaces.
- Prefer dedicated tools (read_file, edit_file, write_file, Glob, grep, list_dir) over shell for file/search work. Keep commands non-interactive.`

const POSIX_DESCRIPTION = `Run a one-off shell command via the system shell (bash/zsh) and wait for it to finish (UTF-8 output). Despite the tool name, on this platform it runs bash/zsh, not PowerShell.

Use this instead of run_terminal_cmd ONLY when you need its extra parameters:
- "working_directory" (optional, workspace-relative): run in a subdirectory instead of the workspace root.
- "timeout_ms" (optional, capped by ${APP_NAME}): allow longer than the default 120s while still waiting for completion.
Otherwise prefer run_terminal_cmd. For commands that should keep running in the background, use StartTerminalTask instead. Do NOT use a very large timeout_ms to wait on slow-but-finishing commands (large downloads, SDK/package installs, big \`git clone\`) in the foreground — background them with StartTerminalTask and poll with ReadTerminalTask instead.

Usage:
- "command": valid POSIX shell (bash/zsh) syntax (\`&&\`, \`||\`, \`export VAR=value\`, pipes); not PowerShell-only cmdlets. Quote paths with spaces.
- Prefer dedicated tools (read_file, edit_file, write_file, Glob, grep, list_dir) over shell for file/search work. Keep commands non-interactive.`

export const POWERSHELL_DESCRIPTION = IS_WIN ? WIN_DESCRIPTION : POSIX_DESCRIPTION
