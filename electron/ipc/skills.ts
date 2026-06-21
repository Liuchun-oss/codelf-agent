import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import type {
  SkillDetail,
  SkillInstallResult,
  SkillOpResult
} from '@shared/skillTypes'
import { loadSkillsForManagement } from '../agent/skills/loadSkills'
import { installSkillFromSource, userSkillsInstallRoot } from '../agent/skills/installSkill'
import { setSkillDisabled } from '../agent/settings/agentSettingsStore'

function isWithinUserSkillsRoot(dir: string): boolean {
  const root = resolve(userSkillsInstallRoot())
  const abs = resolve(dir)
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function registerSkillsIpc(): void {
  ipcMain.handle(
    'skills:list',
    async (_e, workspaceRoot?: string | null): Promise<SkillDetail[]> => {
      return loadSkillsForManagement(workspaceRoot ?? null)
    }
  )

  ipcMain.handle(
    'skills:setEnabled',
    async (_e, name: string, enabled: boolean): Promise<SkillOpResult> => {
      if (typeof name !== 'string' || !name.trim()) return { ok: false, error: '无效的技能名' }
      setSkillDisabled(name, !enabled)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'skills:delete',
    async (_e, name: string, dir: string): Promise<SkillOpResult> => {
      if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: '无效的技能目录' }
      // 安全限制：只允许删除用户安装目录内的技能，内置与项目级不可删。
      if (!isWithinUserSkillsRoot(dir)) {
        return { ok: false, error: '只能删除用户导入的技能（内置/项目技能不可删除）' }
      }
      try {
        await fs.rm(dir, { recursive: true, force: true })
        // 同时清掉禁用名单里的残留项。
        setSkillDisabled(name, false)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'skills:install',
    async (_e, source: string, listOnly?: boolean): Promise<SkillInstallResult> => {
      if (typeof source !== 'string' || !source.trim()) {
        return { ok: false, error: '请填写 Git 地址或 owner/repo' }
      }
      try {
        const result = await installSkillFromSource({ source: source.trim(), listOnly })
        return {
          ok: listOnly ? result.available.length > 0 : result.installed.length > 0,
          label: result.source.label,
          available: result.available,
          installed: result.installed,
          errors: result.errors
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
