export type EnvToolId = 'git' | 'node' | 'python'

export type EnvToolStatus = 'installed' | 'missing' | 'error'

export interface EnvToolResult {
  /** 工具标识 */
  id: EnvToolId
  /** 展示名称 */
  name: string
  /** 检测状态 */
  status: EnvToolStatus
  /** 解析到的版本号，例如 "20.11.0" */
  version?: string
  /** 命令可执行文件的解析路径 */
  path?: string
  /** 检测失败时的错误信息 */
  error?: string
  /** 简短说明，告诉用户该工具的用途 */
  hint: string
  /** 官方下载/安装页面 */
  installUrl: string
  /** 当前操作系统对应的安装指令 */
  installCmd: string
}

export interface EnvCheckResult {
  /** 操作系统平台：win32 / darwin / linux */
  platform: string
  /** 操作系统版本描述 */
  osVersion: string
  /** CPU 架构，例如 x64 / arm64 */
  arch: string
  /** 检测完成的时间戳（ms） */
  checkedAt: number
  /** 各工具的检测结果 */
  tools: EnvToolResult[]
}
