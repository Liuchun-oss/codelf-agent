import KnowledgeManager from '@/components/Knowledge/KnowledgeManager'

export default function KnowledgeSettingsSection(): JSX.Element {
  return (
    <div className="settings-section-page knowledge-settings-wrap">
      <KnowledgeManager variant="settings" />
    </div>
  )
}
