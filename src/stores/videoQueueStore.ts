import { create } from 'zustand'
import type { VideoTask } from '@shared/agentSettings'

interface VideoQueueState {
  tasks: VideoTask[]
  loaded: boolean
  load: () => Promise<void>
  upsert: (task: VideoTask) => void
  remove: (id: string) => void
  cancel: (id: string) => Promise<void>
  del: (id: string) => Promise<void>
  clearFinished: (sessionId?: string) => Promise<void>
  // 仍在进行（queued/running）的任务数，用于角标。
  activeCount: () => number
}

let wired = false

export const useVideoQueueStore = create<VideoQueueState>((set, get) => ({
  tasks: [],
  loaded: false,
  load: async () => {
    const tasks = await window.lc.aiListVideoTasks()
    set({ tasks, loaded: true })
    if (!wired) {
      wired = true
      window.lc.onVideoTaskUpdate((task) => get().upsert(task))
      window.lc.onVideoTaskDeleted(({ id }) => get().remove(id))
      window.lc.onVideoTaskCleared(() => void get().load())
    }
  },
  upsert: (task) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id)
      if (idx === -1) return { tasks: [task, ...s.tasks] }
      const next = [...s.tasks]
      next[idx] = task
      return { tasks: next }
    }),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  cancel: async (id) => {
    const updated = await window.lc.aiCancelVideoTask(id)
    if (updated) get().upsert(updated)
  },
  del: async (id) => {
    await window.lc.aiDeleteVideoTask(id)
    get().remove(id)
  },
  clearFinished: async (sessionId) => {
    await window.lc.aiClearFinishedVideoTasks(sessionId)
    await get().load()
  },
  activeCount: () => get().tasks.filter((t) => t.status === 'queued' || t.status === 'running').length
}))
