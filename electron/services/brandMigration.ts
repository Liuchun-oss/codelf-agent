import { homedir } from 'os'
import { join, dirname, basename } from 'path'
import { existsSync, renameSync, cpSync, rmSync } from 'fs'
import { app } from 'electron'
import { APP_SLUG, PREVIOUS_SLUGS } from '@shared/appConfig'

function migrateDir(currentDir: string, oldDirs: string[]): void {
  if (existsSync(currentDir)) return
  for (const oldDir of oldDirs) {
    if (oldDir === currentDir || !existsSync(oldDir)) continue
    try {
      renameSync(oldDir, currentDir)
      return
    } catch {
      try {
        cpSync(oldDir, currentDir, { recursive: true })
        rmSync(oldDir, { recursive: true, force: true })
        return
      } catch {
        // Leave the old directory untouched if migration fails; the app
        // will start fresh rather than risk corrupting user data.
      }
    }
  }
}

/**
 * One-time migration of user data directories when the app slug changes
 * (e.g. ".oldbrand" -> ".codelf"). Runs at startup before any module reads
 * a data directory. Safe to call repeatedly: it no-ops once the current
 * directory exists or there is nothing to migrate. Covers both the home
 * skills/config dir (~/.slug) and the Electron userData dir (<appData>/<name>).
 */
export function migrateUserDataDir(): void {
  if (PREVIOUS_SLUGS.length === 0) return

  const home = homedir()
  if (home) {
    migrateDir(
      join(home, `.${APP_SLUG}`),
      PREVIOUS_SLUGS.map((slug) => join(home, `.${slug}`))
    )
  }

  try {
    const userData = app.getPath('userData')
    const parent = dirname(userData)
    const currentName = basename(userData)
    migrateDir(
      userData,
      PREVIOUS_SLUGS.filter((slug) => slug !== currentName).map((slug) => join(parent, slug))
    )
  } catch {
    // Electron userData unavailable (non-app context); skip.
  }
}
