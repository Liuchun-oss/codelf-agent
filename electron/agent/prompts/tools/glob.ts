import { APP_NAME } from '@shared/appConfig'

export const GLOB_NAME = 'Glob'

export const GLOB_DESCRIPTION = `Fast file pattern matching tool that works with any codebase size.

Usage:
- Supports glob patterns like "**/*.js" or "src/**/*.ts".
- Use this tool when you need to find files by name patterns.
- "pattern" is matched against workspace-relative POSIX paths. If the pattern does not include a directory, ${APP_NAME} treats it as recursive (for example, "*.ts" behaves like "**/*.ts").
- "path" optionally narrows the search to a workspace-relative directory.
- "limit" optionally caps the number of file paths returned.
- Returns matching file paths. ${APP_NAME} currently sorts paths lexicographically.
- Prefer this tool over shell \`find\` or \`ls\` when locating files by name.
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use codebase_search first if you do not know the exact files or symbols.`
