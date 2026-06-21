/**
 * Monaco editor UI Chinese translations.
 * Keys are the exact English message templates Monaco passes to nls localize().
 * Injected into monaco's nls.js via a Vite transform (see electron.vite.config.ts).
 */
export const MONACO_ZH_CN: Record<string, string> = {
  // Context menu - navigation
  'Go to Definition': '转到定义',
  'Go to Declaration': '转到声明',
  'Go to Type Definition': '转到类型定义',
  'Go to Implementations': '转到实现',
  'Go to References': '转到引用',
  'Go to Symbol...': '转到符号...',
  'Go to Symbol by Category...': '按类别转到符号...',
  Peek: '速览',
  'Peek Definition': '速览定义',
  'Peek References': '速览引用',
  'Peek Declaration': '速览声明',
  'Peek Type Definition': '速览类型定义',
  'Peek Implementations': '速览实现',

  // Context menu - edit / refactor
  'Rename Symbol': '重命名符号',
  'Change All Occurrences': '更改所有匹配项',
  'Format Document': '格式化文档',
  'Format Selection': '格式化选定内容',
  'Refactor...': '重构...',
  'Source Action...': '源代码操作...',
  'Quick Fix...': '快速修复...',

  // Context menu - clipboard
  Cut: '剪切',
  Copy: '复制',
  Paste: '粘贴',
  'Copy As': '复制为',
  'Share': '共享',

  // Command palette
  'Command Palette': '命令面板',

  // Common find/replace & misc widgets
  Find: '查找',
  Replace: '替换',
  'Replace All': '全部替换',
  'Previous Match': '上一个匹配项',
  'Next Match': '下一个匹配项',
  'Toggle Replace': '切换替换',
  'Match Case': '区分大小写',
  'Match Whole Word': '全字匹配',
  'Use Regular Expression': '使用正则表达式',
  'Find in Selection': '在选定内容中查找',
  'Close': '关闭',
  'No results': '无结果',
  'Undo': '撤销',
  'Redo': '重做',
  'Select All': '全选'
}
