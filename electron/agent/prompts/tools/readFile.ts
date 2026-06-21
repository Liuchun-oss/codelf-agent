import { APP_NAME } from '@shared/appConfig'

export const READ_FILE_NAME = 'read_file'

export const READ_FILE_DESCRIPTION = `Reads a file from the local filesystem. In ${APP_NAME}, paths are resolved inside the current workspace for safety.

Assume that if the User provides a path to a file in the workspace, the path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The "path" parameter may be relative to the workspace root, or an absolute path that lives inside the workspace.
- By default, this tool reads the whole file. You can optionally specify "offset" and "limit" (especially handy for long files) to read a slice. "offset" is a 1-based start line and "limit" is the maximum number of lines.
- Results are returned using cat -n style line numbers with a tab separator, with line numbers starting at 1. Treat the line number prefix as metadata — do NOT include it in subsequent edit_file old_string values.
- This tool can only read text files. It returns an error for binary files, image files, or files exceeding the size limit.
- This tool can only read files, not directories. To read a directory, use list_dir.
- If you read a file that exists but has empty contents, you will receive a line-numbered empty line.
- Prefer this tool over running shell \`cat\`, \`head\`, \`tail\`, or \`sed\`.
- For large or unfamiliar codebases, issue several read_file calls in parallel rather than sequentially.`
