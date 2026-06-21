import { APP_NAME } from '@shared/appConfig'

export const NOTEBOOK_EDIT_NAME = 'NotebookEdit'

export const NOTEBOOK_EDIT_DESCRIPTION = `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source, or inserts a new cell at a given index.

Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing.

Usage:
- Use this only for notebook files.
- "path" must point to a .ipynb file inside the workspace. ${APP_NAME} resolves paths relative to the workspace root.
- The cell index is 0-indexed.
- Existing-cell edits require an exact old_string match in that cell.
- New cells require is_new_cell=true and new_string content.
- Use NotebookRead before NotebookEdit to inspect notebook structure, cell indices, cell types, languages, source, and outputs.
- The tool returns a file-change proposal with a diff; approval and writing are handled by ${APP_NAME}.`
