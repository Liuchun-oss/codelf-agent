优化与修复
1. 修复长会话偶发 400「maximum context length」报错：请求的 max_tokens 与 prompt 共用同一上下文窗口，此前按模型输出能力上限（如 39 万）发送，平白预占窗口三分之一，导致本地以为「才用了七成」而服务端直接判超限；现在请求侧统一收敛到 64000，压缩阈值也改为按真实发送值预留，长会话不再撞线
2. 新增 Linux 打包支持：electron-builder 增加 AppImage 与 deb（x64）目标，README 补充 Linux 打包说明与平台支持矩阵
3. Linux 上的更新检查改为比对 GitHub Releases 最新版本后引导前往官网下载（Linux 无签名产物与应用内更新通道）
4. 桌面控制（打开/操作 GUI 应用）相关工具改为仅在 Windows 与 macOS 注册，其他平台不再暴露注定失败的能力，提示词内的相关说明同步按平台生效
