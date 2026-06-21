const LANGUAGE_MAP: Record<string, string> = {
  
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  vue: 'vue',
  svelte: 'html',
  json: 'json',
  jsonc: 'json',
  json5: 'json',

  
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  scala: 'scala',
  groovy: 'groovy',
  gradle: 'groovy',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',

  
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  dockerfile: 'dockerfile',

  
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',

  
  txt: 'plaintext'
}

export function detectLanguage(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  
  if (!name.includes('.')) {
    if (name === 'dockerfile') return 'dockerfile'
    return 'plaintext'
  }
  const ext = name.split('.').pop() ?? ''
  return LANGUAGE_MAP[ext] ?? 'plaintext'
}
