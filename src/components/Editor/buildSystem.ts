import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useEditorStore } from '@/stores/editorStore'
import { useDialogStore } from '@/stores/dialogStore'

export interface BuildPlan {
  
  id: string
  
  label: string
  
  command: string
  
  detail: string
}

function join(root: string, name: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  return `${trimmed}\\${name}`
}

async function exists(root: string, name: string): Promise<boolean> {
  return window.lc.exists(join(root, name))
}


function chain(...steps: string[]): string {
  if (steps.length === 1) return steps[0]
  return steps
    .map((s, i) => (i === 0 ? s : `if ($LASTEXITCODE -eq 0) { ${s} }`))
    .join('; ')
}

interface CMakeConfigurePreset {
  name: string
  displayName?: string
  description?: string
  hidden?: boolean
  binaryDir?: string
  inherits?: string | string[]
}

interface ParsedPreset {
  name: string
  label: string
  description?: string
  
  binaryDir: string
}


function resolveBinaryDir(
  preset: CMakeConfigurePreset,
  byName: Map<string, CMakeConfigurePreset>,
  seen = new Set<string>()
): string {
  if (preset.binaryDir) {
    return preset.binaryDir
      .replace(/\$\{sourceDir\}\/?/g, '')
      .replace(/\$\{presetName\}/g, preset.name)
      .replace(/\//g, '\\')
  }
  const parents = Array.isArray(preset.inherits)
    ? preset.inherits
    : preset.inherits
      ? [preset.inherits]
      : []
  for (const parentName of parents) {
    if (seen.has(parentName)) continue
    seen.add(parentName)
    const parent = byName.get(parentName)
    if (parent) {
      const dir = resolveBinaryDir({ ...parent, name: preset.name }, byName, seen)
      if (dir) return dir
    }
  }
  return `out\\build\\${preset.name}`
}


function archForPreset(name: string): 'amd64' | 'x86' {
  return /(?:^|[-_ ])(x86|win32)(?:$|[-_ ])/i.test(name) ? 'x86' : 'amd64'
}


async function parseCMakePresets(root: string): Promise<ParsedPreset[]> {
  const res = await window.lc.readFileSafe(join(root, 'CMakePresets.json'))
  if (!res.ok || res.kind !== 'text' || !res.content) return []
  let json: { configurePresets?: CMakeConfigurePreset[] }
  try {
    json = JSON.parse(res.content) as { configurePresets?: CMakeConfigurePreset[] }
  } catch {
    return []
  }
  const list = json.configurePresets ?? []
  const byName = new Map(list.map((p) => [p.name, p]))
  return list
    .filter((p) => !p.hidden)
    .map((p) => ({
      name: p.name,
      label: p.displayName ?? p.name,
      description: p.description,
      binaryDir: resolveBinaryDir(p, byName)
    }))
}

const WIN_CONFIGS: { platform: 'x64' | 'Win32'; label: 'x64' | 'x86'; type: 'Debug' | 'Release' }[] = [
  { platform: 'x64', label: 'x64', type: 'Debug' },
  { platform: 'x64', label: 'x64', type: 'Release' },
  { platform: 'Win32', label: 'x86', type: 'Debug' },
  { platform: 'Win32', label: 'x86', type: 'Release' }
]


const VS_DEV_SHELL_PREFIX =
  "$vsw = \"${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe\"; " +
  '$vs = & $vsw -latest -property installationPath; ' +
  "& \"$vs\\Common7\\Tools\\Launch-VsDevShell.ps1\" -Arch __ARCH__ -SkipAutomaticLocation; " +
  "$nj = Join-Path $vs 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\Ninja'; " +
  "if (Test-Path $nj) { $env:PATH = \"$nj;$env:PATH\" }"


function withVsDevShell(arch: 'amd64' | 'x86', command: string): string {
  return `${VS_DEV_SHELL_PREFIX.replace('__ARCH__', arch)}; if ($?) { ${command} }`
}

export async function detectBuildPlans(root: string): Promise<BuildPlan[]> {
  const plans: BuildPlan[] = []
  const has = async (name: string): Promise<boolean> => exists(root, name)

  
  const hasCMakeLists = await has('CMakeLists.txt')
  const hasCMakePresets = await has('CMakePresets.json')

  if (hasCMakePresets) {
    
    const presets = await parseCMakePresets(root)
    for (const p of presets) {
      plans.push({
        id: `cmake-preset-${p.name}`,
        label: `CMake · ${p.label}`,
        command: withVsDevShell(
          archForPreset(p.name),
          chain(`cmake --preset ${p.name}`, `cmake --build "${p.binaryDir}" --parallel`)
        ),
        detail: p.description
          ? `${p.description}（preset: ${p.name}）`
          : `使用 CMake preset「${p.name}」配置并构建。`
      })
    }
    
    for (const p of presets) {
      plans.push({
        id: `cmake-preset-install-${p.name}`,
        label: `CMake 安装 · ${p.label}`,
        command: withVsDevShell(archForPreset(p.name), `cmake --install "${p.binaryDir}"`),
        detail: `仅安装 preset「${p.name}」已构建的产物（不重新编译，需先完成该 preset 的构建）。`
      })
    }
  } else if (hasCMakeLists) {
    
    for (const c of WIN_CONFIGS) {
      const dir = `build\\${c.label}-${c.type.toLowerCase()}`
      plans.push({
        id: `cmake-${c.label}-${c.type.toLowerCase()}`,
        label: `CMake ${c.label} ${c.type}`,
        command: chain(
          `cmake -S . -B "${dir}" -G "Visual Studio 17 2022" -A ${c.platform}`,
          `cmake --build "${dir}" --config ${c.type} --parallel`
        ),
        detail: `多核构建 ${c.label} ${c.type}（输出到 ${dir}，二次构建为增量编译）。`
      })
    }
    for (const c of WIN_CONFIGS) {
      const dir = `build\\${c.label}-${c.type.toLowerCase()}`
      plans.push({
        id: `cmake-install-${c.label}-${c.type.toLowerCase()}`,
        label: `CMake 安装 ${c.label} ${c.type}`,
        command: `cmake --install "${dir}" --config ${c.type}`,
        detail: `仅安装已构建的产物（不重新编译，需先完成 ${c.label} ${c.type} 构建）。`
      })
    }
  }

  
  const rootFiles = await window.lc.rootFileNames(root)
  const slns = rootFiles.filter((f) => f.toLowerCase().endsWith('.sln'))
  const vcxprojs = rootFiles.filter((f) => f.toLowerCase().endsWith('.vcxproj'))
  const msbuildTargets = slns.length > 0 ? slns : vcxprojs
  for (const target of msbuildTargets) {
    for (const c of WIN_CONFIGS) {
      plans.push({
        id: `msbuild-${target}-${c.label}-${c.type.toLowerCase()}`,
        label: `MSBuild ${target} · ${c.label} ${c.type}`,
        command: withVsDevShell(
          c.platform === 'x64' ? 'amd64' : 'x86',
          `msbuild "${target}" /p:Configuration=${c.type} /p:Platform=${c.platform} /m`
        ),
        detail: `通过 VS 开发者环境用 MSBuild 构建 ${target}（${c.label} ${c.type}）。`
      })
    }
  }

  
  if (await has('package.json')) {
    plans.push({
      id: 'npm',
      label: 'npm run build',
      command: 'npm run build',
      detail: '运行 package.json 中的 build 脚本。'
    })
  }
  
  if (await has('Cargo.toml')) {
    plans.push({
      id: 'cargo',
      label: 'Cargo (release)',
      command: 'cargo build --release',
      detail: '以 release 模式编译 Rust 项目。'
    })
  }
  
  if (await has('go.mod')) {
    plans.push({
      id: 'go',
      label: 'go build',
      command: 'go build ./...',
      detail: '编译当前模块下的所有包。'
    })
  }

  
  if (await has('pom.xml')) {
    plans.push({
      id: 'maven',
      label: 'Maven',
      command: 'mvn compile',
      detail: '使用 Maven 编译项目。'
    })
  }
  
  if ((await has('build.gradle')) || (await has('build.gradle.kts'))) {
    plans.push({
      id: 'gradle',
      label: 'Gradle',
      command: '.\\gradlew build',
      detail: '使用 Gradle wrapper 构建项目。'
    })
  }
  
  if ((await has('Makefile')) || (await has('makefile'))) {
    plans.push({
      id: 'make',
      label: 'make',
      command: 'make',
      detail: '运行 Makefile 默认目标。'
    })
  }

  return plans
}

async function saveDirtyEditors(): Promise<void> {
  const editor = useEditorStore.getState()
  const dirty = editor.tabs.filter((t) => t.dirty && t.kind === 'text' && !t.untitled)
  for (const t of dirty) await editor.saveTab(t.path)
}


export async function runBuildPlan(plan: BuildPlan): Promise<void> {
  await saveDirtyEditors()
  await useTerminalStore.getState().runCommand(plan.command)
}

export async function buildProject(): Promise<void> {
  const root = useWorkspaceStore.getState().workspace?.path
  if (!root) {
    await notify('没有打开工作区', '请先打开一个项目文件夹再进行构建。')
    return
  }

  const plans = await detectBuildPlans(root)
  if (plans.length === 0) {
    await notify(
      '未识别到构建方式',
      '没有在工作区根目录找到已知的构建配置（如 CMakePresets.json、package.json、Cargo.toml、Makefile 等）。'
    )
    return
  }

  let plan = plans[0]
  if (plans.length > 1) {
    const key = await useDialogStore.getState().pick({
      title: '选择构建方式',
      message: '检测到多个可用的构建配置，请选择一个：',
      items: plans.map((p) => ({
        key: p.id,
        label: p.label,
        detail: p.detail
      }))
    })
    if (!key) return
    plan = plans.find((p) => p.id === key) ?? plan
  }

  await runBuildPlan(plan)
}

async function notify(title: string, message: string): Promise<void> {
  await useDialogStore.getState().confirm({
    title,
    message,
    confirmText: '知道了',
    cancelText: '关闭'
  })
}
