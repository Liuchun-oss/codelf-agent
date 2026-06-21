

export function systemReminder(message: string): string {
  return `<system-reminder>\n${message.trim()}\n</system-reminder>`
}


export function dirtyConflictReminder(path: string): string {
  return systemReminder(
    `The file "${path}" has unsaved changes in the editor. Writes are blocked to prevent overwriting the user's work. Ask the user to save the file (or discard their changes) before retrying, or propose a different approach.`
  )
}


export function permissionDeniedReminder(toolName: string): string {
  return systemReminder(
    `The user denied the previous "${toolName}" call. Do not immediately retry the same call with the same arguments — consider why it was denied and choose a different approach (ask for clarification, narrow the change, or stop).`
  )
}


export function truncatedOutputReminder(detail = ''): string {
  const tail = detail ? ` ${detail}` : ''
  return systemReminder(
    `The previous tool output was truncated to fit context.${tail} If you need more, narrow your query (e.g. add a path filter, refine the regex, or read a specific range) instead of asking for the whole thing.`
  )
}
