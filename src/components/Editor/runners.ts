/**
 * Language → run-command mapping for the editor's Run button (Code-Runner style).
 * Each runner builds a shell command from the quoted file path. Python is handled
 * separately because it uses the user-selected interpreter.
 */

export interface RunnerSpec {
  
  label: string
  
  build: (quotedPath: string, quotedDir: string, baseName: string) => string
  
  win?: (quotedPath: string, quotedDir: string, baseName: string) => string
}

/** Languages whose files open in the system browser instead of running in a terminal. */
export const BROWSER_LANGUAGES = new Set(['html'])

/**
 * Map of monaco language id → runner. Commands assume the matching toolchain is on PATH.
 * `&` prefix for Windows is added by the caller for paths that need the call operator.
 */
export const RUNNERS: Record<string, RunnerSpec> = {
  javascript: {
    label: 'Node.js',
    build: (p) => `node ${p}`
  },
  typescript: {
    label: 'ts-node',
    build: (p) => `npx -y ts-node ${p}`
  },
  go: {
    label: 'Go',
    build: (p) => `go run ${p}`
  },
  rust: {
    label: 'Rust',
    
    build: (p, _dir, base) => `rustc ${p} -o ${base}.out && ./${base}.out`,
    win: (p, _dir, base) => `rustc ${p} -o ${base}.exe; & .\\${base}.exe`
  },
  ruby: {
    label: 'Ruby',
    build: (p) => `ruby ${p}`
  },
  php: {
    label: 'PHP',
    build: (p) => `php ${p}`
  },
  lua: {
    label: 'Lua',
    build: (p) => `lua ${p}`
  },
  perl: {
    label: 'Perl',
    build: (p) => `perl ${p}`
  },
  r: {
    label: 'Rscript',
    build: (p) => `Rscript ${p}`
  },
  shell: {
    label: 'Bash',
    build: (p) => `bash ${p}`
  },
  powershell: {
    label: 'PowerShell',
    build: (p) => `& ${p}`,
    win: (p) => `& ${p}`
  },
  bat: {
    label: 'Batch',
    build: (p) => `& ${p}`,
    win: (p) => `& ${p}`
  },
  java: {
    label: 'Java',
    
    build: (p) => `java ${p}`
  },
  groovy: {
    label: 'Groovy',
    build: (p) => `groovy ${p}`
  },
  dart: {
    label: 'Dart',
    build: (p) => `dart run ${p}`
  }
}

/** Whether the editor should show a Run button for the given language / file. */
export function isRunnable(language: string | undefined, path: string): boolean {
  if (!language) return false
  if (language === 'python' || /\.pyw?$/i.test(path)) return true
  if (BROWSER_LANGUAGES.has(language)) return true
  return language in RUNNERS
}
