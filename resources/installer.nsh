; 自定义 NSIS 脚本：卸载时询问并清理用户数据
; 本文件由 scripts/sync-brand.mjs 依据 shared/brand.json 自动生成，请勿手改。
; $APPDATA 指向 %APPDATA%（Roaming），$PROFILE 指向用户主目录 C:\Users\<用户>

!macro customUnInstall
  ; oneClick:false 模式下卸载需要交互，这里弹窗询问是否清除个人数据
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 Codelf 的个人数据？$\r$\n$\r$\n包含：API 密钥、会话历史、设置、日志，以及用户技能目录 (~/.codelf)。$\r$\n$\r$\n选择“是”将彻底清除，无法恢复；选择“否”将保留以便重装后继续使用。" IDYES codelf_purge IDNO codelf_keep

  codelf_purge:
    DetailPrint "正在删除用户数据..."
    RMDir /r "$APPDATA\codelf"
    RMDir /r "$PROFILE\.codelf"
    DetailPrint "用户数据已清除。"
    Goto codelf_purge_done

  codelf_keep:
    DetailPrint "已保留用户数据。"

  codelf_purge_done:
!macroend
