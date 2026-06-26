import { useCallback, useEffect, useState } from 'react'
import type {
  ChannelRuntimeStatus,
  ChannelConnectionStatus,
  WeixinChannelSettings
} from '@shared/channelTypes'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'
import WeixinQrDialog from '@/components/Channels/WeixinQrDialog'

const STATUS_META: Record<ChannelConnectionStatus, { label: string; color: string }> = {
  disconnected: { label: '未连接', color: '#e5484d' },
  connecting: { label: '连接中…', color: '#f5a623' },
  connected: { label: '已连接', color: '#30a46c' },
  expired: { label: '已失效，需重连', color: '#f5a623' },
  error: { label: '运行出错', color: '#e5484d' }
}

export default function ChannelsSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<WeixinChannelSettings | null>(null)
  const [status, setStatus] = useState<ChannelRuntimeStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [hasModel, setHasModel] = useState<boolean | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.channels.getSettings()
    setSettings(s.weixin)
    const st = await window.lc.channels.getStatus('weixin')
    setStatus(st)
    try {
      const active = await window.lc.aiGetActiveProfile()
      setHasModel(Boolean(active))
    } catch {
      setHasModel(null)
    }
  }, [])

  useEffect(() => {
    void load()
    const off = window.lc.channels.onStatus((st) => {
      if (st.channelId === 'weixin') setStatus(st)
    })
    return off
  }, [load])

  const save = async (patch: Partial<WeixinChannelSettings>): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.channels.saveWeixinSettings(patch)
      setSettings(next.weixin)
    } finally {
      setSaving(false)
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.lc.channels.pickWorkspace()
    if (dir) void save({ workspaceRoot: dir })
  }

  const savePersona = (patch: Partial<WeixinChannelSettings['persona']>): void => {
    if (!settings) return
    void save({ persona: { ...settings.persona, ...patch } })
  }

  const resetPersona = (): void => {
    void save({
      persona: { activated: false, selfName: '', ownerName: '', addressing: '', style: '' }
    })
  }

  const logout = async (): Promise<void> => {
    await window.lc.channels.logout()
    void load()
  }

  if (!settings) {
    return (
      <div className="settings-section-page">
        <div className="settings-inline-alert">加载中…</div>
      </div>
    )
  }

  const conn = status?.status ?? 'disconnected'
  const meta = STATUS_META[conn]
  const connected = conn === 'connected' || conn === 'expired' || conn === 'error'

  return (
    <div className="settings-section-page">
      {hasModel === false && (
        <div className="settings-inline-alert" style={{ color: '#f5a623' }}>
          尚未配置 AI 模型。微信已可连接，但收到消息时只会回复「请先配置模型」，且无法完成首次人格激活。请先到「模型」设置里配置并激活一个 Provider。
        </div>
      )}
      <SettingsGroup label="微信">
        <SettingsRow
          title="连接状态"
          description={
            status?.accountId
              ? `账号 ${status.accountId}`
              : '未连接微信。首次使用请阅读风险说明并扫码连接。'
          }
          control={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: meta.color,
                  display: 'inline-block'
                }}
              />
              {meta.label}
            </span>
          }
        />

        <SettingsRow
          title="我已知晓风险并同意"
          description="首次连接前必须勾选：私有协议、可能被风控、建议用小号、仅自用。"
          control={
            <SettingsSwitch
              disabled={saving}
              checked={settings.riskAcknowledged}
              onChange={(v) => void save({ riskAcknowledged: v })}
            />
          }
        />

        <SettingsRow
          title="连接操作"
          description="扫码连接微信，或断开当前登录。"
          control={
            <div style={{ display: 'flex', gap: 8 }}>
              {!connected && (
                <button
                  type="button"
                  className="btn"
                  disabled={!settings.riskAcknowledged}
                  title={settings.riskAcknowledged ? '' : '请先勾选风险同意'}
                  onClick={() => setShowQr(true)}
                >
                  连接微信
                </button>
              )}
              {connected && (
                <>
                  <button type="button" className="btn-secondary" onClick={() => setShowQr(true)}>
                    重新登录
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => void logout()}>
                    断开
                  </button>
                </>
              )}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="配置项">
        <SettingsRow
          title="启用微信通道"
          description="关 = 停止长轮询；开 = 启动。初始默认关，首次扫码成功后自动开启。"
          control={
            <SettingsSwitch
              disabled={saving}
              checked={settings.enabled}
              onChange={(v) => void save({ enabled: v })}
            />
          }
        />
        <SettingsRow
          title="专属工作区"
          description="微信会话固定作用的目录。留空则仅能聊天，不操作文件。"
          stacked
          control={
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder="D:\\codelf-wx"
                disabled={saving}
                value={settings.workspaceRoot}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, workspaceRoot: e.target.value } : s))
                }
                onBlur={() => void save({ workspaceRoot: settings.workspaceRoot })}
              />
              <button type="button" className="btn-secondary" onClick={() => void pickWorkspace()}>
                选择…
              </button>
            </div>
          }
        />
        <SettingsRow
          title="权限模式"
          description="固定为「每次危险操作确认」，不可更改（安全防线）。"
          control={<span style={{ opacity: 0.7 }}>每次危险操作确认 🔒</span>}
        />
        <SettingsRow
          title="3 秒合并窗口"
          description="3 秒内同一会话的连续消息合并成一轮再发给 Agent。"
          control={
            <SettingsSwitch
              disabled={saving}
              checked={settings.mergeWindowEnabled}
              onChange={(v) => void save({ mergeWindowEnabled: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="运行信息">
        <SettingsRow
          title="最近收到消息"
          control={
            <span style={{ opacity: 0.7 }}>
              {status?.lastInboundAt
                ? new Date(status.lastInboundAt).toLocaleString()
                : '—'}
            </span>
          }
        />
        <SettingsRow
          title="主动通知"
          description="本地任务完成/出错时推消息到微信。点此发一条测试通知给机主。"
          control={
            <button
              type="button"
              className="btn-secondary"
              disabled={!connected}
              onClick={() => void window.lc.channels.testNotify()}
            >
              发送测试通知
            </button>
          }
        />
        {status?.message && (
          <SettingsRow title="最近提示" control={<span style={{ opacity: 0.7 }}>{status.message}</span>} />
        )}
      </SettingsGroup>

      <SettingsGroup label="人格定义（出厂设置 · 仅微信）">
        <SettingsRow
          title="激活状态"
          description={
            settings.persona.activated
              ? '已完成首次激活。以下设定会作为永久系统提示词注入每一轮对话。'
              : '尚未激活。首次给微信发消息时，我会主动询问并请你定义身份；也可以在这里手动填写。'
          }
          control={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: settings.persona.activated ? '#30a46c' : '#8b8b8b',
                  display: 'inline-block'
                }}
              />
              {settings.persona.activated ? '已激活' : '未激活'}
            </span>
          }
        />
        <SettingsRow
          title="我的名字"
          description="AI 自称的名字。"
          stacked
          control={
            <input
              type="text"
              style={{ width: '100%' }}
              placeholder="如：小灵"
              disabled={saving}
              value={settings.persona.selfName}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, persona: { ...s.persona, selfName: e.target.value } } : s
                )
              }
              onBlur={() => savePersona({ selfName: settings.persona.selfName })}
            />
          }
        />
        <SettingsRow
          title="主人的名字"
          description="对方（你）的名字。"
          stacked
          control={
            <input
              type="text"
              style={{ width: '100%' }}
              placeholder="如：阿杰"
              disabled={saving}
              value={settings.persona.ownerName}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, persona: { ...s.persona, ownerName: e.target.value } } : s
                )
              }
              onBlur={() => savePersona({ ownerName: settings.persona.ownerName })}
            />
          }
        />
        <SettingsRow
          title="对你的称呼"
          description="希望 AI 怎么称呼你。"
          stacked
          control={
            <input
              type="text"
              style={{ width: '100%' }}
              placeholder="如：主人 / 老板"
              disabled={saving}
              value={settings.persona.addressing}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, persona: { ...s.persona, addressing: e.target.value } } : s
                )
              }
              onBlur={() => savePersona({ addressing: settings.persona.addressing })}
            />
          }
        />
        <SettingsRow
          title="身份 / 风格 / 语气 / 性格"
          description="一段自由描述，定义 AI 的人设和说话方式。"
          stacked
          control={
            <textarea
              style={{ width: '100%', minHeight: 72, resize: 'vertical' }}
              placeholder="如：温柔体贴的助理，说话简洁、偶尔俏皮，遇到不确定的事会先确认。"
              disabled={saving}
              value={settings.persona.style}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, persona: { ...s.persona, style: e.target.value } } : s
                )
              }
              onBlur={() => savePersona({ style: settings.persona.style })}
            />
          }
        />
        <SettingsRow
          title="激活开关"
          description="开 = 上述设定立即生效；关 = 下次微信发消息时重新引导激活。"
          control={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <SettingsSwitch
                disabled={saving}
                checked={settings.persona.activated}
                onChange={(v) =>
                  savePersona(
                    v
                      ? { activated: true, activatedAt: Date.now() }
                      : { activated: false }
                  )
                }
              />
              <button type="button" className="btn-secondary" disabled={saving} onClick={resetPersona}>
                重置
              </button>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="微信侧可用指令">
        <div className="settings-row-text" style={{ padding: '4px 0', lineHeight: 1.9 }}>
          <small>
            <code>/stop</code> 中止当前一轮 · <code>/new</code> 清空上下文重开会话 ·{' '}
            <code>/cwd &lt;路径&gt;</code> 临时切换工作区（无参或 reset 切回专属工作区） ·{' '}
            <code>/remember</code> 把本会话稳定知识沉淀进项目记忆 ·{' '}
            <code>/persona</code> 查看人格（<code>/persona reset</code> 重新激活）
          </small>
        </div>
      </SettingsGroup>

      <WeixinQrDialog
        open={showQr}
        onClose={() => setShowQr(false)}
        onConnected={() => {
          setShowQr(false)
          void load()
        }}
      />
    </div>
  )
}
