import { create } from 'zustand'
import type { UpdateStatus } from '@shared/updateTypes'
import { toast } from '@/stores/toastStore'

interface UpdateState {
  status: UpdateStatus | null
  /** 更新对话框是否打开。 */
  dialogOpen: boolean
  /** 是否为用户主动点击“检查更新”触发（决定“已是最新”是否提示）。 */
  manual: boolean
  init: () => void
  checkNow: () => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  install: () => void
  openDownloadPage: () => void
}

let unsub: (() => void) | null = null

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: null,
  dialogOpen: false,
  manual: false,

  init: () => {
    if (unsub) return
    void window.lc.update.status().then((s) => set({ status: s }))
    unsub = window.lc.update.onStatus((s) => {
      const prev = get().status
      set({ status: s })
      // 后台静默检查时：下载完成才弹提示，避免打扰。
      if (!get().dialogOpen) {
        if (s.phase === 'downloaded' && prev?.phase !== 'downloaded') {
          toast.info(`新版本 ${s.info?.version ?? ''} 已就绪，可在“关于”中重启安装`)
          set({ dialogOpen: true })
        } else if (s.phase === 'available' && !s.canAutoUpdate && prev?.phase !== 'available') {
          // macOS：无法自动更新，提示去官网下载。
          set({ dialogOpen: true })
        }
      }
    })
  },

  checkNow: async () => {
    set({ manual: true, dialogOpen: true })
    await window.lc.update.check()
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false, manual: false }),
  install: () => void window.lc.update.install(),
  openDownloadPage: () => void window.lc.update.openDownloadPage()
}))
