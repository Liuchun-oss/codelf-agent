import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const NLS_FORMAT_ANCHOR = 'function _format(message, args) {'
const NLS_ZH_INJECT =
  NLS_FORMAT_ANCHOR +
  '\n    try { var __zh = globalThis.__MONACO_ZH__; if (__zh && typeof message === "string" && __zh[message]) message = __zh[message]; } catch (e) {}'


function fixMonacoMarkedSourceMap(): import('vite').Plugin {
  return {
    name: 'fix-monaco-marked-sourcemap',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('monaco-editor/esm/vs/base/common/marked/marked.js')) {
        return
      }
      return code.replace(/\n\/\/# sourceMappingURL=[^\n]*/g, '')
    }
  }
}

/** Inject a Chinese translation lookup into Monaco's nls _format chokepoint. */
function monacoNlsZh(): import('vite').Plugin {
  return {
    name: 'monaco-nls-zh',
    enforce: 'pre',
    
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: 'monaco-nls-zh-esbuild',
                setup(build: import('esbuild').PluginBuild) {
                  build.onLoad(
                    { filter: /monaco-editor[\\/].*[\\/]nls\.js$/ },
                    (args: { path: string }) => {
                      const src = readFileSync(args.path, 'utf8')
                      return {
                        contents: src.replace(NLS_FORMAT_ANCHOR, NLS_ZH_INJECT),
                        loader: 'js'
                      }
                    }
                  )
                }
              }
            ]
          }
        }
      }
    },
    
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('monaco-editor/esm/vs/nls.js')) return
      return code.replace(NLS_FORMAT_ANCHOR, NLS_ZH_INJECT)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          embedWorker: resolve(__dirname, 'electron/services/semantic/embedWorker.ts'),
          knowledgeEmbedWorker: resolve(
            __dirname,
            'electron/services/knowledge/knowledgeEmbedWorker.ts'
          )
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    plugins: [fixMonacoMarkedSourceMap(), monacoNlsZh(), react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          overlayHud: resolve(__dirname, 'src/overlay/hud.html'),
          overlayMarquee: resolve(__dirname, 'src/overlay/marquee.html')
        }
      }
    }
  }
})
