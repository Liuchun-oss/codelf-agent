export const SNIP_HISTORY_NAME = 'snip_history'

export const SNIP_HISTORY_DESCRIPTION = `Remove selected older conversation turns from the model-facing context while keeping a compact marker.

Use this when earlier investigation or tool output is no longer relevant and the current conversation is getting too long.

Behavior:
- This does not delete the saved chat transcript.
- Snipped turns are excluded from future model requests to save context tokens.
- A short marker remains so the model knows history was snipped.
- Use search_history later if you need to recover details from older conversation turns.

When to use:
- After large command outputs, broad searches, or exploratory reads are no longer needed.
- After completing a phase of work where only the conclusions matter.
- When context is getting long and keeping recent turns is enough to continue safely.

When not to use:
- Do not snip information that is still needed to make correct edits or decisions.
- Do not use this to hide mistakes or remove user instructions.

Inputs:
- "reason": concise reason for snipping.
- "turnIds": explicit turn ids to snip.
- "beforeTurnId": snip turns before this turn id.
- "keepRecentTurns": alternatively snip older turns while keeping the most recent N turns.

You must provide at least one of turnIds, beforeTurnId, or keepRecentTurns.`
