import { APP_NAME } from '@shared/appConfig'

export const ENTER_WORKTREE_NAME = 'EnterWorktree'
export const EXIT_WORKTREE_NAME = 'ExitWorktree'

export const ENTER_WORKTREE_DESCRIPTION = `Create or enter a git worktree for the current session and route future workspace-relative tool calls to that worktree.

Use this tool ONLY when the user explicitly asks to work in a worktree or isolated checkout. This tool creates an isolated git worktree and switches the current ${APP_NAME} session workspace root into it.

## When to Use
- The user explicitly says "worktree" (for example, "start a worktree", "work in a worktree", "create a worktree", "use a worktree").
- The user explicitly asks for isolated implementation work without modifying the main checkout.

## When NOT to Use
- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead.
- The user asks to fix a bug or work on a feature — use normal workflow unless they specifically mention worktrees or isolation.
- Never use this tool just because the task is complex.

## Requirements and Behavior
- The current workspace must be a git repository.
- The tool uses local git worktree operations; it does not use MCP or terminal panes.
- It creates/enters a worktree and updates ${APP_NAME}'s workspace root so future workspace-relative tool calls target that worktree.
- Use ExitWorktree to leave the worktree mid-session.

## Parameters
- "name" is required: a short safe worktree slug, for example "feature-auth" or "experiments-ui".
- "baseRef" is optional: git ref to branch from; defaults to HEAD.`

export const EXIT_WORKTREE_DESCRIPTION = `Exit the current session worktree and return workspace-relative tool calls to the original workspace root.

## Scope
This tool only operates on the worktree session created by EnterWorktree in this ${APP_NAME} session. It does not manage arbitrary worktrees created manually with git commands.

## When to Use
- The user explicitly asks to exit, leave, or go back from the worktree.
- You have finished work in the worktree and the user wants to return to the original workspace.
- Do NOT call this proactively if the user expects to keep working in the worktree.

## Parameters
- "remove" is optional boolean.
  - false or omitted: exit the worktree and keep the worktree directory on disk.
  - true: exit and attempt to remove the worktree. Only set true when the user explicitly asks to remove it or when it is safe to discard it.

## Behavior
- Restores the session workspace root to where it was before EnterWorktree.
- If remove=true, attempts to remove the worktree after exiting.
- If no worktree session is active, the tool reports an error/no active session rather than touching unrelated filesystem state.`
