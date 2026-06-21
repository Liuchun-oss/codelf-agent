import { create } from 'zustand'
import { usePythonStore } from '@/stores/pythonStore'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { detectLanguage } from '@/utils/language'
import { resolveRunPlan, dirOfPath } from '@/components/Editor/runPlan'

export type RunStatus = 'starting' | 'running' | 'done' | 'error'

export interface OutputChunk {
  data: string
  stream: 'stdout' | 'stderr'
}

export interface InlineRun {
  id: string
  /** Artifact file path this run was launched for (key for UI lookup). */
  path: string
  label: string
  command: string
  status: RunStatus
  chunks: OutputChunk[]
  exitCode: number | null
  /** First http(s) URL detected in output (e.g. dev server address). */
  detectedUrl: string | null
  startedAt: number
}

interface RunState {
  /** Active/last run per artifact path. */
  runs: Record<string, InlineRun>
  /** Map backend run id → artifact path for event routing. */
  idToPath: Record<string, string>

  runArtifact: (path: string) => Promise<void>
  stopRun: (path: string) => Promise<void>
  clearRun: (path: string) => void
  appendOutput: (id: string, data: string, stream: 'stdout' | 'stderr') => void
  finishRun: (id: string, exitCode: number | null, error?: string) => void
}

// 只探测本地回环地址(dev server),不匹配外部域名:内嵌 iframe 预览仅对
// 本地服务有意义,且 CSP 的 frame-src 也只放行了 localhost/127.0.0.1。
const URL_RE = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/[^\s'"]*)?/i

function extractUrl(text: string): string | null {
  const m = text.match(URL_RE)
  if (!m) return null
  return m[0].replace(/0\.0\.0\.0/, 'localhost').replace(/\[::1\]/, 'localhost')
}

function sessionCwd(): string | null {
  const ag = useAgentStore.getState()
  const meta = ag.sessions.find((m) => m.id === ag.currentSessionId)
  return meta?.cwd ?? useWorkspaceStore.getState().workspace?.path ?? null
}

/** Build a browser-loadable file URL, handling Windows drive paths. */
function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  // Windows: "D:/a/b.html" → "file:///D:/a/b.html"; POSIX: "/a/b" → "file:///a/b".
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${withLeadingSlash}`
}

export const useRunStore = create<RunState>((set, get) => ({
  runs: {},
  idToPath: {},

  runArtifact: async (path) => {
    // 同一产物若已有运行中的进程,先停掉,避免重复点击产生孤儿进程。
    const existing = get().runs[path]
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      await window.lc.runStop(existing.id)
    }

    const language = detectLanguage(path)

    // Ensure a Python interpreter is available before building the plan.
    let pythonExe: string | null = null
    if (language === 'python' || /\.pyw?$/i.test(path)) {
      const py = usePythonStore.getState()
      if (!py.selected) {
        if (!py.loaded) await py.init()
        if (usePythonStore.getState().envs.length === 0) await py.discover()
      }
      pythonExe = usePythonStore.getState().selected?.executable ?? null
    }

    const plan = resolveRunPlan(path, language, pythonExe)

    if (plan.kind === 'browser') {
      // HTML preview is handled inline by the card via file:// iframe; also
      // record a run entry so the card can render the preview affordance.
      set((s) => ({
        runs: {
          ...s.runs,
          [path]: {
            id: `browser-${path}`,
            path,
            label: plan.label,
            command: '',
            status: 'done',
            chunks: [],
            exitCode: 0,
            detectedUrl: toFileUrl(path),
            startedAt: Date.now()
          }
        }
      }))
      return
    }

    if (plan.kind === 'python' && !plan.command) {
      set((s) => ({
        runs: {
          ...s.runs,
          [path]: {
            id: `err-${path}`,
            path,
            label: plan.label,
            command: '',
            status: 'error',
            chunks: [{ data: '未选择 Python 解释器，请在底部状态栏选择后重试。\n', stream: 'stderr' }],
            exitCode: null,
            detectedUrl: null,
            startedAt: Date.now()
          }
        }
      }))
      return
    }

    if (plan.kind === 'unsupported' || !plan.command) {
      set((s) => ({
        runs: {
          ...s.runs,
          [path]: {
            id: `err-${path}`,
            path,
            label: plan.label,
            command: '',
            status: 'error',
            chunks: [{ data: '当前文件类型还没有配置运行方式。\n', stream: 'stderr' }],
            exitCode: null,
            detectedUrl: null,
            startedAt: Date.now()
          }
        }
      }))
      return
    }

    const cwd = sessionCwd() ?? dirOfPath(path)

    // Seed a starting entry immediately for responsive UI.
    set((s) => ({
      runs: {
        ...s.runs,
        [path]: {
          id: `pending-${path}`,
          path,
          label: plan.label,
          command: plan.command!,
          status: 'starting',
          chunks: [],
          exitCode: null,
          detectedUrl: null,
          startedAt: Date.now()
        }
      }
    }))

    const res = await window.lc.runStart(plan.command, cwd)
    if (!res.ok || !res.id) {
      set((s) => {
        const run = s.runs[path]
        if (!run) return s
        return {
          runs: {
            ...s.runs,
            [path]: {
              ...run,
              status: 'error',
              chunks: [...run.chunks, { data: res.error ?? '运行启动失败\n', stream: 'stderr' }]
            }
          }
        }
      })
      return
    }

    set((s) => {
      const run = s.runs[path]
      if (!run) return s
      return {
        idToPath: { ...s.idToPath, [res.id!]: path },
        runs: { ...s.runs, [path]: { ...run, id: res.id!, status: 'running' } }
      }
    })
  },

  stopRun: async (path) => {
    const run = get().runs[path]
    if (!run) return
    await window.lc.runStop(run.id)
  },

  clearRun: (path) => {
    set((s) => {
      const next = { ...s.runs }
      delete next[path]
      return { runs: next }
    })
  },

  appendOutput: (id, data, stream) => {
    set((s) => {
      const path = s.idToPath[id]
      if (!path) return s
      const run = s.runs[path]
      if (!run) return s
      const detectedUrl = run.detectedUrl ?? extractUrl(data)
      return {
        runs: {
          ...s.runs,
          [path]: { ...run, chunks: [...run.chunks, { data, stream }], detectedUrl }
        }
      }
    })
  },

  finishRun: (id, exitCode, error) => {
    set((s) => {
      const path = s.idToPath[id]
      if (!path) return s
      const run = s.runs[path]
      if (!run) return s
      const chunks = error
        ? [...run.chunks, { data: `\n[错误] ${error}\n`, stream: 'stderr' as const }]
        : run.chunks
      const nextId = { ...s.idToPath }
      delete nextId[id]
      return {
        idToPath: nextId,
        runs: {
          ...s.runs,
          [path]: {
            ...run,
            status: error || (exitCode != null && exitCode !== 0) ? 'error' : 'done',
            exitCode,
            chunks
          }
        }
      }
    })
  }
}))

let wired = false

/** Subscribe to main-process run events once. Call from app bootstrap. */
export function initRunStoreListeners(): void {
  if (wired) return
  wired = true
  window.lc.onRunData(({ id, data, stream }) => {
    useRunStore.getState().appendOutput(id, data, stream)
  })
  window.lc.onRunExit(({ id, exitCode, error }) => {
    useRunStore.getState().finishRun(id, exitCode, error)
  })
}
