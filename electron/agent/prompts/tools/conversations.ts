export const LIST_CONVERSATIONS_NAME = 'list_conversations'

export const LIST_CONVERSATIONS_DESCRIPTION = `Lists other saved conversations (chat tabs) that belong to the SAME workspace as the current session.

Why this exists:
- Each chat tab is persisted separately on disk. This tool lets you discover sibling conversations so you can summarize past work (e.g. "what did I do this week") or locate a specific discussion.

Usage:
- Returns one line per conversation: its id, title, last-updated time, and message count, sorted by most-recently-updated first.
- Only conversations from the current workspace are returned; conversations from other workspaces are never exposed.
- Optional "since" filters by last-updated time. Accept either an ISO date (e.g. "2026-06-15") or a relative window: "today", "week" (last 7 days), "month" (last 30 days).
- The current conversation is included and marked. Use the returned id with read_conversation to read a conversation's full content.
- This is read-only.`

export const READ_CONVERSATION_NAME = 'read_conversation'

export const READ_CONVERSATION_DESCRIPTION = `Reads the message history of another saved conversation (chat tab) in the SAME workspace, identified by its conversation id.

Why this exists:
- To summarize or reference what happened in a different chat tab. Get ids from list_conversations, or the user may paste an id they copied from a tab's right-click menu.

Usage:
- "conversationId" is required. It must belong to the current workspace; ids from other workspaces are rejected for privacy.
- Optional "query" returns only messages whose text contains the keyword (case-insensitive); omit it to read the whole conversation.
- Optional "limit" caps the number of messages returned (most relevant / most recent first). Long content is truncated.
- This is read-only.`
