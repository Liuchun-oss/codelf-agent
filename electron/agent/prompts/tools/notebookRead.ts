export const NOTEBOOK_READ_NAME = 'NotebookRead'

export const NOTEBOOK_READ_DESCRIPTION = `Read a Jupyter .ipynb notebook and return a compact cell-by-cell text view.

Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing.

Usage:
- Use this before NotebookEdit to inspect notebook structure, cell indices, cell types, languages, source, and optionally outputs.
- "path" must point to a .ipynb notebook inside the workspace.
- "include_outputs" optionally includes compact cell outputs. Leave it false/omitted when outputs are large or not needed.
- "cell_idx" optionally returns only one zero-based cell index.
- The output shows notebook metadata summary and cells as # Cell N headers. Use those zero-based indices for NotebookEdit.
- This tool reads notebooks as JSON and renders text; it does not execute notebook cells.
- Output may be truncated for large notebooks. If you only need one cell, use cell_idx.`
