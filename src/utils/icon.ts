




const FOLDER_BY_NAME: Record<string, string> = {
  node_modules: 'node',
  '.git': 'git',
  '.github': 'github',
  '.vscode': 'vscode',
  src: 'src',
  app: 'src',
  lib: 'src',
  dist: 'dist',
  build: 'dist',
  out: 'dist',
  public: 'public',
  static: 'public',
  assets: 'images',
  images: 'images',
  img: 'images',
  components: 'component',
  component: 'component',
  views: 'component',
  test: 'test',
  tests: 'test',
  __tests__: 'test',
  scripts: 'script',
  styles: 'css',
  style: 'css',
  css: 'css'
}


const FILE_BY_NAME: Record<string, string> = {
  'package.json': 'file-type-npm',
  'package-lock.json': 'file-type-npm',
  'yarn.lock': 'file-type-yarn',
  'pnpm-lock.yaml': 'file-type-pnpm',
  '.npmrc': 'file-type-npm',
  '.nvmrc': 'file-type-node',
  '.gitignore': 'file-type-git',
  '.gitattributes': 'file-type-git',
  '.gitmodules': 'file-type-git',
  '.editorconfig': 'file-type-editorconfig',
  '.dockerignore': 'file-type-docker',
  'electron-builder.yml': 'file-type-electron',
  'electron-builder.yaml': 'file-type-electron'
}


const FILE_BY_EXT: Record<string, string> = {
  
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'reactts',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'reactjs',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  jsonc: 'json',
  json5: 'json5',
  
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
  h: 'cheader',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cppheader',
  hh: 'cppheader',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dartlang',
  scala: 'scala',
  groovy: 'groovy',
  gradle: 'gradle',
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
  
  sql: 'sql',
  xml: 'xml',
  svg: 'svg',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  pdf: 'pdf2',
  zip: 'zip',
  rar: 'zip',
  '7z': 'zip',
  gz: 'zip',
  tar: 'zip',
  log: 'log',
  txt: 'text',
  env: 'dotenv'
}

const DEFAULT_FILE = 'default-file'


export function getFileIconName(name: string): string {
  const lower = name.toLowerCase()

  if (FILE_BY_NAME[lower]) return FILE_BY_NAME[lower]

  
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'file-type-docker'
  if (lower.startsWith('tsconfig') && lower.endsWith('.json')) return 'file-type-tsconfig'
  if (lower.startsWith('vite.config.')) return 'file-type-vite'
  if (lower.startsWith('vitest.config.')) return 'file-type-vitest'
  if (lower.startsWith('.env')) return 'file-type-dotenv'
  if (lower.startsWith('.eslintrc') || lower.startsWith('eslint.config.')) return 'file-type-eslint'
  if (lower.startsWith('.prettierrc') || lower.startsWith('prettier.config.'))
    return 'file-type-prettier'
  if (lower.startsWith('.babelrc') || lower.startsWith('babel.config.')) return 'file-type-babel'
  if (lower.startsWith('webpack.')) return 'file-type-webpack'
  if (lower.startsWith('license')) return 'file-type-license'

  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : ''
  const suffix = FILE_BY_EXT[ext]
  return suffix ? `file-type-${suffix}` : DEFAULT_FILE
}


export function getFolderIconName(name: string, expanded: boolean): string {
  const key = FOLDER_BY_NAME[name.toLowerCase()]
  if (key) return expanded ? `folder-type-${key}-opened` : `folder-type-${key}`
  return expanded ? 'default-folder-opened' : 'default-folder'
}
