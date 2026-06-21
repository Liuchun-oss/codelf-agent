import { APP_NAME } from '@shared/appConfig'

export const GET_DIAGNOSTICS_NAME = 'get_diagnostics'

export const GET_DIAGNOSTICS_DESCRIPTION = `Read language-server diagnostics (errors and warnings) for files in the workspace.

This is ${APP_NAME}'s lightweight code-intelligence tool focused on diagnostics reported by the editor/language server.

Supported operation:
- List diagnostics for all open files, or for a single file when "path" is provided.

Usage:
- Call without "path" to list diagnostics for all open files with LSP/TypeScript markers.
- Call with "path" to filter to a single file relative to the workspace root.
- Diagnostics are returned as path, line, column, severity, optional source, and message.
- Returns an empty list when no language server is active or no issues are reported.
- Use this after editing files to check whether TypeScript/LSP errors were introduced.
- If you need definition/reference/hover/call hierarchy behavior, use codebase_search, grep, Glob, and read_file as a fallback because this tool only returns diagnostics.`
