import { APP_NAME } from '@shared/appConfig'

export const MULTI_EDIT_NAME = 'multi_edit'

export const MULTI_EDIT_DESCRIPTION = `Make multiple exact string replacements in a single file and return one combined diff proposal.
Use this when several independent edits must be applied to the same file. For a single replacement, use edit_file instead. Each edit is applied sequentially to the result of the previous edit. The tool does not write directly to disk; ${APP_NAME} will show the combined diff for review or auto-accept according to the current permission mode.

Requirements:
- Read the target file before calling this tool.
- Each old_string must match exactly, including whitespace and indentation.
- By default each old_string must be unique; set replace_all for an edit only when replacing every occurrence is intended.
- Do not use this tool for different files; call it once per file.`
