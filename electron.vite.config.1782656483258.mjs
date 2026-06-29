// electron.vite.config.ts
import { resolve } from "path";
import { readFileSync } from "fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
var __electron_vite_injected_dirname = "D:\\codelf";
var NLS_FORMAT_ANCHOR = "function _format(message, args) {";
var NLS_ZH_INJECT = NLS_FORMAT_ANCHOR + '\n    try { var __zh = globalThis.__MONACO_ZH__; if (__zh && typeof message === "string" && __zh[message]) message = __zh[message]; } catch (e) {}';
function fixMonacoMarkedSourceMap() {
  return {
    name: "fix-monaco-marked-sourcemap",
    enforce: "pre",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").includes("monaco-editor/esm/vs/base/common/marked/marked.js")) {
        return;
      }
      return code.replace(/\n\/\/# sourceMappingURL=[^\n]*/g, "");
    }
  };
}
function monacoNlsZh() {
  return {
    name: "monaco-nls-zh",
    enforce: "pre",
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: "monaco-nls-zh-esbuild",
                setup(build) {
                  build.onLoad(
                    { filter: /monaco-editor[\\/].*[\\/]nls\.js$/ },
                    (args) => {
                      const src = readFileSync(args.path, "utf8");
                      return {
                        contents: src.replace(NLS_FORMAT_ANCHOR, NLS_ZH_INJECT),
                        loader: "js"
                      };
                    }
                  );
                }
              }
            ]
          }
        }
      };
    },
    transform(code, id) {
      if (!id.replace(/\\/g, "/").includes("monaco-editor/esm/vs/nls.js")) return;
      return code.replace(NLS_FORMAT_ANCHOR, NLS_ZH_INJECT);
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve(__electron_vite_injected_dirname, "shared")
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/main/index.ts"),
          embedWorker: resolve(__electron_vite_injected_dirname, "electron/services/semantic/embedWorker.ts"),
          knowledgeEmbedWorker: resolve(
            __electron_vite_injected_dirname,
            "electron/services/knowledge/knowledgeEmbedWorker.ts"
          )
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "electron/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: "src",
    plugins: [fixMonacoMarkedSourceMap(), monacoNlsZh(), react()],
    resolve: {
      alias: {
        "@": resolve(__electron_vite_injected_dirname, "src"),
        "@shared": resolve(__electron_vite_injected_dirname, "shared")
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
