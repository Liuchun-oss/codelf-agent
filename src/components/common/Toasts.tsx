import { useToastStore } from '@/stores/toastStore'

export default function Toasts(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-text">{t.text}</span>
          <span className="toast-close">×</span>
        </div>
      ))}
    </div>
  )
}
