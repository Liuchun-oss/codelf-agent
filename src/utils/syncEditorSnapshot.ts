import { useEditorStore } from '@/stores/editorStore'


export function syncEditorDirtyPaths(): void {
  const paths = useEditorStore
    .getState()
    .tabs.filter((t) => t.dirty && !t.untitled && t.kind === 'text')
    .map((t) => t.path)
  void window.lc.editorUpdateDirtyPaths(paths)
}
