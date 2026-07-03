/** 自动更新对渲染层暴露的状态机。 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateInfo {
  version: string
  releaseNotes?: string | null
  releaseName?: string | null
  releaseDate?: string | null
}

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateStatus {
  phase: UpdatePhase
  /** 当前应用版本。 */
  currentVersion: string
  /** 检测到的最新版本信息（available / downloaded 时有值）。 */
  info?: UpdateInfo | null
  /** 下载进度（downloading 时有值）。 */
  progress?: UpdateProgress | null
  /** 错误信息（phase === 'error' 时有值）。 */
  error?: string | null
  /**
   * 当前平台是否支持应用内自动下载安装。
   * Windows 为 true；未签名的 macOS 为 false，只能跳转官网手动下载。
   */
  canAutoUpdate: boolean
}
