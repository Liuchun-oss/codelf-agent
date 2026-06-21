import { ipcMain } from 'electron'
import {
  searchInFiles,
  replaceInFiles,
  type SearchOptions,
  type SearchResponse
} from '../services/searchService'

export type { SearchOptions, SearchResponse } from '../services/searchService'

export function registerSearchIpc(): void {
  ipcMain.handle(
    'search:inFiles',
    async (_e, root: string, query: string, opts: SearchOptions): Promise<SearchResponse> =>
      searchInFiles(root, query, opts)
  )

  ipcMain.handle(
    'search:replace',
    async (_e, paths: string[], query: string, replacement: string, opts: SearchOptions) =>
      replaceInFiles(paths, query, replacement, opts)
  )
}
