export const TERMINAL_NAME = 'run_terminal_cmd'

export const TERMINAL_DESCRIPTION = `Run a one-off shell command in the workspace root and wait for it to finish; returns exit code, stdout, stderr. Uses the machine's shell (Windows PowerShell on Windows, bash elsewhere); shell state does not persist between calls.

This is the DEFAULT tool for running commands. Choose a different tool when:
- You need a different working directory or a timeout longer than 120s (but still want to wait): use PowerShell.
- The command keeps running (dev server, watcher) or you want to continue working while it runs: use StartTerminalTask.
- A dedicated tool fits the task better: Glob (find files), grep (search content), read_file, edit_file, write_file, list_dir. Use shell for tests, builds, package managers, git, and other system commands.

Usage:
- "command" runs at the workspace root in the current shell; write it for that shell. On Windows PowerShell do not use bash-only syntax (\`&&\`, \`||\`, heredocs, \`export\`, \`rm -rf\`); use \`; if ($?) { ... }\`, \`$env:VAR=...\`, \`Remove-Item\`. Quote paths with spaces; prefer absolute paths over \`cd\`.
- Make commands non-interactive (add \`-y\`/\`--yes\`, set \`CI=1\`); interactive prompts can't be answered here (use StartTerminalTask + WriteTerminalTask for that). Long output is truncated; commands over 120s are killed.
- Run independent commands as parallel calls; chain dependent ones in one command.
- Git: prefer new commits over amend; avoid destructive ops (reset --hard, push --force) and --no-verify unless explicitly requested.`
