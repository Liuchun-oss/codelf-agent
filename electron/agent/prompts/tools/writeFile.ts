import { APP_NAME } from '@shared/appConfig'

export const WRITE_FILE_NAME = 'write_file'
export const WRITE_FILE_DESCRIPTION = `Writes a file to the local filesystem. In ${APP_NAME}, the change is proposed as a diff and written only after approval.

Usage:
- "path" is relative to the workspace root. "content" is the full new file content; do not include line-number prefixes from read_file output.
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read_file tool first so you do not accidentally overwrite unrelated changes.
- Prefer edit_file for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- The change is shown to the user as a diff and requires approval before it is written to disk, unless the user enabled Accept Edits mode.
- The write is rejected if the target file has unsaved changes open in the editor — coordinate with the user instead of overwriting.
- LARGE FILES (roughly >300 lines / >12k characters): do NOT emit the whole file in a single write_file call. A huge "content" string is slow to generate and can time out or be truncated. Instead, write a short skeleton first (imports, top-level structure, and placeholder markers such as // __SECTION_1__), then use edit_file repeatedly to replace each placeholder with the real implementation in small chunks. This keeps each tool call small and reliable.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`

export const EDIT_FILE_NAME = 'edit_file'
export const EDIT_FILE_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your read_file tool before editing the target file so old_string matches the current file contents.
- "path" is relative to the workspace root.
- When editing text from read_file output, match the exact indentation (tabs/spaces) that appears AFTER the line-number prefix. Never include the line-number prefix in old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.
- When building up a large file from a skeleton, replace one placeholder marker per edit_file call and keep each new_string reasonably small (a single function or section) so the call stays fast and does not get truncated.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- For several separate edits to the same file, prefer multi_edit to bundle them into one diff.
- The change is shown as a diff and requires user approval, unless Accept Edits is on. Edits to a file with unsaved editor changes are rejected.`

export const DELETE_FILE_NAME = 'delete_file'
export const DELETE_FILE_DESCRIPTION = `Deletes a file from the workspace.

Usage:
- "path" is relative to the workspace root.
- This is destructive. With auto-approval (Accept Edits) off, it requires explicit user approval; with auto-approval on, it runs without prompting.
- Do NOT use this to clean up working files you created earlier in the turn — leave them and let the user decide.
- Prefer edit_file or write_file for content changes. Only delete files when removal is explicitly required by the task.`
