import { Menu, BrowserWindow, app, shell, type MenuItemConstructorOptions } from 'electron'
import { cleanupRendererBoundResources } from './services/appLifecycle'
import { APP_NAME, APP_WEBSITE } from '@shared/appConfig'

let appMenu: Menu | null = null




function send(id: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:command', id)
}

function item(label: string, commandId: string, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: () => send(commandId) }
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件(&F)',
      submenu: [
        item('新建文件', 'file.new', 'CommandOrControl+N'),
        item('打开文件夹…', 'workspace.open', 'CommandOrControl+O'),
        item('关闭工作区', 'workspace.close'),
        { type: 'separator' },
        item('建立 / 更新代码索引', 'semantic.build'),
        { type: 'separator' },
        item('快速打开文件…', 'file.quickOpen', 'CommandOrControl+P'),
        { type: 'separator' },
        item('保存', 'file.save', 'CommandOrControl+S'),
        { type: 'separator' },
        item('关闭标签', 'editor.close', 'CommandOrControl+W'),
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
        { type: 'separator' },
        item('格式化文档', 'editor.format'),
        item('重命名符号', 'editor.rename'),
        item('查找所有引用', 'editor.findReferences')
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        item('命令面板…', 'view.commandPalette', 'CommandOrControl+Shift+P'),
        { type: 'separator' },
        item('资源管理器', 'view.explorer', 'CommandOrControl+Shift+E'),
        item('搜索', 'view.search', 'CommandOrControl+Shift+F'),
        item('源代码管理', 'view.scm', 'CommandOrControl+Shift+G'),
        item('切换侧边栏', 'view.toggleSidebar', 'CommandOrControl+B'),
        item('切换终端', 'view.toggleTerminal', 'CommandOrControl+`'),
        item('切换 AI 面板', 'view.toggleAgent', 'CommandOrControl+Shift+A'),
        { type: 'separator' },
        item('转到符号…', 'editor.gotoSymbol', 'CommandOrControl+Shift+O'),
        { type: 'separator' },
        item('设置', 'view.settings'),
        { type: 'separator' },
        { label: '重新加载', click: () => {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          void cleanupRendererBoundResources().finally(() => win?.webContents.reload())
        } },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '构建(&B)',
      submenu: [item('构建项目', 'build.project', 'CommandOrControl+Shift+B')]
    },
    {
      label: '终端(&T)',
      submenu: [item('新建终端', 'terminal.new')]
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: `访问 ${APP_NAME} 官网`, click: () => void shell.openExternal(APP_WEBSITE) },
        { type: 'separator' },
        { label: `关于 ${app.getName()}`, role: 'about' }
      ]
    }
  ]

  appMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(appMenu)
}


export function popupAppMenu(
  index: number,
  clientX: number,
  clientY: number,
  win: BrowserWindow
): void {
  if (!appMenu) return
  const item = appMenu.items[index]
  if (!item?.submenu) return
  item.submenu.popup({
    window: win,
    x: Math.round(clientX),
    y: Math.round(clientY)
  })
}
