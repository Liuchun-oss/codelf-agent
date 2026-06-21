export const LIST_DIR_NAME = 'list_dir'

export const LIST_DIR_DESCRIPTION = `Lists the entries of a single directory in the workspace (one level, non-recursive).

Usage:
- "path" is relative to the workspace root; omit it to list the workspace root.
- Directory entries are marked with a trailing \`/\`. Common noise directories (\`node_modules\`, \`.git\`, \`dist\`, etc.) are omitted.
- Use this to discover project structure before reading files. Prefer this tool over shell \`ls\` or \`find\`.
- For broad recursive exploration prefer issuing list_dir on a few promising sub-paths in parallel rather than scanning the whole tree at once.`
