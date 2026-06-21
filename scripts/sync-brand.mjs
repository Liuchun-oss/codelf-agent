import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brand = JSON.parse(readFileSync(resolve(root, 'shared/brand.json'), 'utf8'))

const changed = []

function patch(relPath, transform) {
  const file = resolve(root, relPath)
  const before = readFileSync(file, 'utf8')
  const after = transform(before)
  if (after !== before) {
    writeFileSync(file, after)
    changed.push(relPath)
  }
}

// package.json: name / version / description / author
patch('package.json', (src) => {
  const pkg = JSON.parse(src)
  pkg.name = brand.slug
  pkg.version = brand.version
  pkg.description = brand.description
  pkg.author = brand.author
  return JSON.stringify(pkg, null, 2) + '\n'
})

// electron-builder.yml: appId / productName / copyright / shortcutName
patch('electron-builder.yml', (src) =>
  src
    .replace(/^appId:.*$/m, `appId: ${brand.appId}`)
    .replace(/^productName:.*$/m, `productName: ${brand.name}`)
    .replace(/^copyright:.*$/m, `copyright: ${brand.copyright}`)
    .replace(/^(\s*shortcutName:).*$/m, `$1 ${brand.name}`)
)

// src/index.html: <title>
patch('src/index.html', (src) =>
  src.replace(/<title>.*<\/title>/, `<title>${brand.name}</title>`)
)

// resources/installer.nsh: NSIS uninstaller (display name + data-dir paths)
patch('resources/installer.nsh', () => {
  const s = brand.slug
  return `; 自定义 NSIS 脚本：卸载时询问并清理用户数据
; 本文件由 scripts/sync-brand.mjs 依据 shared/brand.json 自动生成，请勿手改。
; $APPDATA 指向 %APPDATA%（Roaming），$PROFILE 指向用户主目录 C:\\Users\\<用户>

!macro customUnInstall
  ; oneClick:false 模式下卸载需要交互，这里弹窗询问是否清除个人数据
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 ${brand.name} 的个人数据？$\\r$\\n$\\r$\\n包含：API 密钥、会话历史、设置、日志，以及用户技能目录 (~/.${s})。$\\r$\\n$\\r$\\n选择“是”将彻底清除，无法恢复；选择“否”将保留以便重装后继续使用。" IDYES ${s}_purge IDNO ${s}_keep

  ${s}_purge:
    DetailPrint "正在删除用户数据..."
    RMDir /r "$APPDATA\\${s}"
    RMDir /r "$PROFILE\\.${s}"
    DetailPrint "用户数据已清除。"
    Goto ${s}_purge_done

  ${s}_keep:
    DetailPrint "已保留用户数据。"

  ${s}_purge_done:
!macroend
`
})

if (changed.length) {
  console.log(`brand 同步完成 → ${brand.name} (${brand.slug} v${brand.version})`)
  for (const f of changed) console.log(`  updated ${f}`)
} else {
  console.log('brand 已是最新，无需同步')
}
