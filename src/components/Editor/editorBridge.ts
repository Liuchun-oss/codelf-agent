import type { editor } from 'monaco-editor'


let instance: editor.IStandaloneCodeEditor | null = null

export function setEditorInstance(ed: editor.IStandaloneCodeEditor | null): void {
  instance = ed
}

export function getEditorInstance(): editor.IStandaloneCodeEditor | null {
  return instance
}


export async function formatDocument(): Promise<boolean> {
  const ed = instance
  if (!ed) return false
  ed.focus()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  try {
    await ed.getAction('editor.action.formatDocument')?.run()
    return true
  } catch {
    return false
  }
}


export async function gotoSymbol(): Promise<boolean> {
  const ed = instance
  if (!ed) return false
  ed.focus()
  
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  try {
    await ed.getAction('editor.action.quickOutline')?.run()
    return true
  } catch {
    return false
  }
}


export async function runEditorAction(actionId: string): Promise<boolean> {
  const ed = instance
  if (!ed) return false
  ed.focus()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  try {
    await ed.getAction(actionId)?.run()
    return true
  } catch {
    return false
  }
}
