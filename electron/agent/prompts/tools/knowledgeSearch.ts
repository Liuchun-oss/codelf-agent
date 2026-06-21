export const KNOWLEDGE_SEARCH_NAME = 'knowledge_search'

export const KNOWLEDGE_SEARCH_DESCRIPTION = `Searches the user's imported document knowledge base (RAG) and returns the most relevant passages with their source.

Use this when the user's question may be answered by their own imported documents (e.g. manuals, specs, reports, contracts, notes) rather than by the code in the workspace.

Usage:
- "query" should be a natural-language question or keywords in the user's language (the knowledge base is optimized for Chinese).
- "kbId" selects which knowledge base to search. If omitted, the **most recently created** knowledge base is used automatically. Call with no kbId first if you are unsure; if multiple knowledge bases exist and the result is irrelevant, tell the user which knowledge base was searched and ask which one they want to use instead.
- Results are ranked passages, each labeled with its source document title/path and the section heading, plus a relevance score (0-1, higher is more relevant). Tables in documents are preserved as Markdown.
- If results are weak (low score < 0.4) or empty, reformulate with synonyms or more specific terms and retry a few variations before concluding the information is absent.
- Always cite the source document (title and, when available, the heading) when you use information returned by this tool.
- This searches imported documents only. To search the workspace's source code, use codebase_search instead.`
