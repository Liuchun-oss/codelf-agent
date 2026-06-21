export type SkillSourceKind = 'builtin' | 'user' | 'project'

export interface SkillsSettings {
  disabled: string[]
}

export const DEFAULT_SKILLS_SETTINGS: SkillsSettings = {
  disabled: []
}

export interface SkillDetail {
  name: string
  displayName?: string
  description: string
  whenToUse?: string
  version?: string
  source: SkillSourceKind
  dir: string
  enabled: boolean
  deletable: boolean
}

export interface SkillInstalledItem {
  name: string
  targetDir: string
  notes: string[]
  files: string[]
}

export interface SkillInstallResult {
  ok: boolean
  error?: string
  label?: string
  available?: string[]
  installed?: SkillInstalledItem[]
  errors?: string[]
}

export interface SkillOpResult {
  ok: boolean
  error?: string
}

export function normalizeSkillsSettings(raw: unknown): SkillsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SKILLS_SETTINGS }
  const disabledRaw = (raw as { disabled?: unknown }).disabled
  const disabled = Array.isArray(disabledRaw)
    ? [...new Set(disabledRaw.map((v) => String(v).trim().toLowerCase()).filter(Boolean))]
    : []
  return { disabled }
}
