export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'unknown'

export interface GitFileChange {
  
  path: string
  
  displayPath: string
  
  origPath?: string
  
  status: GitFileStatus
  
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  
  root?: string
  
  branch?: string
  
  detached?: boolean
  
  ahead?: number
  behind?: number
  
  hasUpstream?: boolean
  
  staged: GitFileChange[]
  unstaged: GitFileChange[]
}

export interface GitDiffContent {
  ok: boolean
  
  original: string
  
  modified: string
  
  language?: string
  
  binary?: boolean
  error?: string
}

export interface GitBranch {
  name: string
  current: boolean
}

export interface GitOpResult {
  ok: boolean
  error?: string
}

export interface GitCommitResult extends GitOpResult {
  
  hash?: string
}

export interface GitGenerateMessageResult {
  ok: boolean
  message?: string
  error?: string
}
