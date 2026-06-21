export const CODEBASE_SEARCH_NAME = 'codebase_search'

export const CODEBASE_SEARCH_DESCRIPTION = `Finds the code most relevant to a natural-language or keyword query by ranking the workspace, and returns the top code snippets.

Use this when you need to locate "where is X handled" or "which code relates to Y" and you do not yet know the exact symbol or string to grep for.

Usage:
- "query" can be a natural-language description or several keywords, for example "user authentication login".
- When a semantic index has been built for the workspace, matching is semantic (embedding-based): it can find conceptually related code even when the exact words differ. Otherwise it falls back to lexical keyword ranking.
- Results are ranked code snippets, each labeled with \`path:startLine-endLine\` and a relevance score. Respects .gitignore; skips binary and very large files.
- If results are weak or empty, reformulate with synonyms or more concrete vocabulary and try a few variations; do not assume the concept is absent after one query.
- For exact known strings or symbols, use grep instead.
- For finding files by name or extension, use Glob instead.
- For reading a specific file, use read_file instead.
- Follow up by reading the most promising files with read_file to confirm the real symbol names, then grep those symbols to map all usages before acting.`
