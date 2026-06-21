export const SEARCH_HISTORY_NAME = 'search_history'

export const SEARCH_HISTORY_DESCRIPTION = `Searches the full conversation history of the current session for a keyword or phrase.

Why this exists:
- When a long conversation grows past the context window, earlier turns are automatically summarized ("compacted") and their full text is no longer in your context. The complete history is still saved on disk.
- Use this tool to recover specific details (exact file paths, decisions, error messages, values) that the summary may have dropped.

Usage:
- "query" is matched case-insensitively as a substring against the recorded user/assistant messages.
- Returns the matching entries with their position and a short excerpt around the match. If nothing matches, you get an empty result — refine the query.
- This is read-only. Prefer it over guessing when you suspect a relevant fact was discussed earlier but is missing from the visible context.`
