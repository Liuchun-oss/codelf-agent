import brand from './brand.json'

export const APP_CONFIG = {
  name: brand.name,
  tagline: brand.tagline,
  slug: brand.slug,
  version: brand.version,
  description: brand.description,
  website: brand.website,
  appId: brand.appId,
  copyright: brand.copyright,
  author: brand.author
} as const

export type AppConfig = typeof APP_CONFIG

export const APP_NAME = APP_CONFIG.name
export const APP_TAGLINE = APP_CONFIG.tagline
export const APP_WEBSITE = APP_CONFIG.website
export const APP_SLUG = APP_CONFIG.slug
export const APP_VERSION = APP_CONFIG.version

/** Slugs used by previous releases, for one-time data-dir migration on startup. */
export const PREVIOUS_SLUGS: readonly string[] = Array.isArray(
  (brand as { previousSlugs?: unknown }).previousSlugs
)
  ? ((brand as { previousSlugs: unknown[] }).previousSlugs.filter(
      (s): s is string => typeof s === 'string' && s.length > 0 && s !== brand.slug
    ) as string[])
  : []

/** Env-safe uppercase prefix derived from the slug, e.g. "codelf" -> "CODELF". */
export const ENV_PREFIX = APP_SLUG.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()

/** User/project data directory name, e.g. ".codelf". */
export const DATA_DIR_NAME = `.${APP_SLUG}`

/** Project-level MCP config file name, stored under DATA_DIR_NAME (e.g. ".codelf/mcp.json"). */
export const PROJECT_MCP_FILE_NAME = 'mcp.json'

/** Custom protocol scheme for in-app browser preview images. */
export const BROWSER_PREVIEW_SCHEME = `${APP_SLUG}-preview`

/** Custom protocol scheme for serving local artifact files (HTML/assets) into iframes. */
export const ARTIFACT_FILE_SCHEME = `${APP_SLUG}-artifact`

/** Monaco command id for the AI quick-fix action. */
export const LSP_FIX_COMMAND_ID = `${APP_SLUG}.aiFixDiagnostics`

/** Marker separating static and dynamic system-prompt sections. */
export const PROMPT_DYNAMIC_BOUNDARY = `__${ENV_PREFIX}_PROMPT_DYNAMIC_BOUNDARY__`

/** Renderer-exposed window global used to export diagnostics to the main process. */
export const DIAGNOSTICS_GLOBAL = `__${APP_SLUG}GetDiagnostics`

/** Identifier reported as the MCP client name. */
export const MCP_CLIENT_NAME = APP_SLUG

/** Connectivity-probe tool name used by provider test connections. */
export const PROBE_TOOL_NAME = `${APP_SLUG}_probe`

export const ENV_SKILLS_DIR = `${ENV_PREFIX}_SKILLS_DIR`
export const ENV_USER_SKILLS_DIR = `${ENV_PREFIX}_USER_SKILLS_DIR`
export const ENV_PROJECT_DIR = `${ENV_PREFIX}_PROJECT_DIR`

export const DND_PATHS_MIME = `application/x-${APP_SLUG}-paths`

export function appStorageKey(suffix: string): string {
  return `${APP_SLUG}:${suffix}`
}

/** Slug-prefixed name for tmp dirs/files, e.g. tmpName("tool-results") -> "codelf-tool-results". */
export function tmpName(suffix: string): string {
  return `${APP_SLUG}-${suffix}`
}

/** HTTP User-Agent string, e.g. userAgent("WebSearch") -> "Codelf/1.0 (+WebSearch)". */
export function userAgent(feature: string): string {
  return `${APP_NAME}/1.0 (+${feature})`
}

/**
 * 判断给定端点是否为火山方舟（Volcengine Ark）。
 * 仅火山端点支持 `watermark` 字段；其它端点（OpenAI 等）开启严格参数校验时，
 * 多传 watermark 会被拒绝（HTTP 400 "property watermark should not exist"）。
 */
export function isVolcEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.includes('volces.com') || host.includes('volcengine') || host.includes('ark.cn-')
  } catch {
    return /volces\.com|volcengine|ark\.cn-/i.test(baseUrl)
  }
}
