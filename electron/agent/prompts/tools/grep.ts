export const GREP_NAME = 'grep'

export const GREP_DESCRIPTION = `A powerful search tool for searching file contents across the workspace.

Usage:
- ALWAYS use grep for search tasks when you know the exact string or regular expression. NEVER invoke shell \`grep\` or \`rg\` as a run_terminal_cmd command. The grep tool has been optimized for workspace access, permissions, and readable results.
- "query" is a literal string by default. Set "regex": true to treat it as a regular expression.
- Set "caseSensitive": true for case-sensitive matching. Default is case-insensitive.
- "path" optionally narrows the search to a subdirectory relative to the workspace root.
- Results are returned as \`path:line:column: preview\`. Respects .gitignore. Skips binary and very large files.
- Output may be truncated when there are many matches; refine your query with more specific text, a narrower path, or regex anchors to see more.
- Pattern syntax: when regex=true, escape literal regex metacharacters. For example, use \`interface\\{\\}\` to find \`interface{}\` in Go code.
- Use codebase_search for open-ended searches where you do not yet know the exact symbol, string, or file (searching by concept or behavior). Use grep once you know the exact text — including locating the definition of a known function/class/constant by name.
- Issue multiple grep calls in parallel when scanning for several independent symbols.`
