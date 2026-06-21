import { useThemeStore, THEME_PRESETS, ACCENT_PRESETS } from '@/stores/themeStore'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export default function AppearanceSettingsSection(): JSX.Element {
  const presetId = useThemeStore((s) => s.presetId)
  const accent = useThemeStore((s) => s.accent)
  const setPreset = useThemeStore((s) => s.setPreset)
  const setAccent = useThemeStore((s) => s.setAccent)

  return (
    <div className="settings-section-page">
      <SettingsGroup label="背景主题">
        <SettingsRow
          title="配色方案"
          description="选择整体背景与表面色调。"
          stacked
          control={
            <div className="theme-preset-grid">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`theme-preset-card${presetId === p.id ? ' active' : ''}`}
                  onClick={() => setPreset(p.id)}
                  title={p.label}
                >
                  <span
                    className="theme-preset-swatch"
                    style={{
                      background: p.vars['--bg'],
                      borderColor: p.vars['--border']
                    }}
                  >
                    <i style={{ background: p.vars['--bg-elevated'] }} />
                    <i style={{ background: p.vars['--bg-hover'] }} />
                  </span>
                  <span className="theme-preset-name">{p.label}</span>
                </button>
              ))}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="强调色">
        <SettingsRow
          title="预设色"
          description="用于按钮、链接、选中态等高亮元素。"
          stacked
          control={
            <div className="accent-swatch-row">
              {ACCENT_PRESETS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`accent-swatch${accent.toLowerCase() === a.hex.toLowerCase() ? ' active' : ''}`}
                  style={{ background: a.hex }}
                  onClick={() => setAccent(a.hex)}
                  title={a.label}
                  aria-label={a.label}
                />
              ))}
            </div>
          }
        />
        <SettingsRow
          title="自定义颜色"
          description="任意指定一个十六进制强调色。"
          control={
            <input
              type="color"
              className="accent-color-input"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}
