// 跨平台 dev 启动入口。
// Windows 的控制台默认用 GBK(代码页 936)解码 stdout，而本项目源码与日志均为 UTF-8，
// 直接运行会把中文日志显示成乱码（如「开始长轮询收消息」→「寮€濮嬮暱杞鏀舵秷鎭」）。
// 这里在 Windows 上先 chcp 65001 把控制台切到 UTF-8，再启动 electron-vite；其它平台原样启动。

import { spawn } from 'child_process'

const isWin = process.platform === 'win32'

const command = isWin ? 'chcp 65001 >nul && electron-vite dev' : 'electron-vite dev'

const child = spawn(command, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
})

child.on('exit', (code) => process.exit(code ?? 0))
