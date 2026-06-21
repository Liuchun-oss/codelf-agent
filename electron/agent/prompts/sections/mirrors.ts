import type { PromptContext } from '../types'


function isChineseLocale(responseLanguage: string): boolean {
  return /chinese|中文|汉语|普通话|zh\b|zh-/i.test(responseLanguage)
}


export function getMirrorsSection(ctx: PromptContext): string {
  if (!isChineseLocale(ctx.responseLanguage)) return ''

  return `# Package mirrors (China network)

The user is in a China network environment where official package/SDK sources are often slow or unreachable. By DEFAULT, use well-known domestic mirrors for downloads and dependency installs (npm, pip, Flutter/Dart, Homebrew, apt/yum, Maven/Gradle, Go, GitHub release binaries, etc.). Only use the official source when the user explicitly asks for it (e.g. "用官方源"). For large downloads, also background the command with StartTerminalTask.`
}
