export type PythonEnvKind = 'global' | 'conda' | 'venv' | 'pyenv' | 'unknown'

export interface PythonEnv {
  
  id: string
  
  executable: string
  
  version?: string
  
  kind: PythonEnvKind
  
  label: string
  
  detail: string
  
  recommended?: boolean
}

export interface PythonDiscoverResult {
  ok: boolean
  envs: PythonEnv[]
  error?: string
}

export interface PythonSelectionResult {
  ok: boolean
  env?: PythonEnv | null
  error?: string
}
