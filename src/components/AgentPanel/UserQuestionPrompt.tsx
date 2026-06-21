import { useRef, useState } from 'react'
import type { AskUserQuestionItem } from '@shared/agentTypes'
import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'
import MarkdownView from './MarkdownView'
import BrowserPreviewImage from './BrowserPreviewImage'

function joinMulti(values: string[]): string {
  return values.filter(Boolean).join(', ')
}

function StructuredQuestionForm({ msg, questions }: { msg: ChatMessageView; questions: AskUserQuestionItem[] }): JSX.Element {
  const respond = useAgentStore((s) => s.respondUserQuestion)
  const [selected, setSelected] = useState<Record<string, string | string[]>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [pageIndex, setPageIndex] = useState(0)
  const otherInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const total = questions.length
  const safeIndex = Math.min(pageIndex, total - 1)
  const current = questions[safeIndex]
  const isLast = safeIndex >= total - 1

  const focusOtherInput = (question: AskUserQuestionItem): void => {
    const key = question.question
    setOtherActive((prev) => ({ ...prev, [key]: true }))
    if (!question.multiSelect) {
      setSelected((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
    requestAnimationFrame(() => otherInputRefs.current[key]?.focus())
  }

  const toggleOther = (question: AskUserQuestionItem): void => {
    const key = question.question
    const active = Boolean(otherActive[key]) || (otherText[key]?.trim().length ?? 0) > 0
    if (active) {
      setOtherActive((prev) => ({ ...prev, [key]: false }))
      setOtherText((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      return
    }
    focusOtherInput(question)
  }

  const setSingle = (question: string, label: string): void => {
    setOtherActive((prev) => ({ ...prev, [question]: false }))
    setOtherText((prev) => {
      const next = { ...prev }
      delete next[question]
      return next
    })
    setSelected((prev) => ({ ...prev, [question]: label }))
  }

  const toggleMulti = (question: string, label: string): void => {
    setSelected((prev) => {
      const current = Array.isArray(prev[question]) ? prev[question] as string[] : []
      const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
      return { ...prev, [question]: next }
    })
  }

  const answerFor = (question: AskUserQuestionItem): string => {
    const other = otherText[question.question]?.trim()
    const value = selected[question.question]
    if (question.multiSelect) {
      const labels = Array.isArray(value) ? value : []
      return joinMulti(other ? [...labels, other] : labels)
    }
    if (other) return other
    return Array.isArray(value) ? joinMulti(value) : value ?? ''
  }

  const canSubmit = questions.every((q) => answerFor(q).trim().length > 0)

  const submit = (): void => {
    const answers: Record<string, string> = {}
    const annotations: Record<string, { preview?: string; notes?: string }> = {}
    for (const question of questions) {
      const answer = answerFor(question).trim()
      if (!answer) return
      answers[question.question] = answer
      const selectedLabels = Array.isArray(selected[question.question])
        ? selected[question.question] as string[]
        : selected[question.question]
          ? [selected[question.question] as string]
          : []
      const preview = question.options.find((option) => selectedLabels.includes(option.label))?.preview
      const note = notes[question.question]?.trim()
      if (preview || note) annotations[question.question] = { ...(preview ? { preview } : {}), ...(note ? { notes: note } : {}) }
    }
    const answer = Object.entries(answers).map(([q, a]) => `${q} -> ${a}`).join('\n')
    respond(msg.id, { answer, answers, annotations })
  }

  const currentAnswered = answerFor(current).trim().length > 0

  const needsMultiHint = (question: AskUserQuestionItem): boolean => {
    if (!question.multiSelect) return false
    return !/多选|多项|multi-?select|multiple/i.test(question.question)
  }

  const renderQuestion = (question: AskUserQuestionItem, index: number): JSX.Element => {
    const value = selected[question.question]
    const other = otherText[question.question] ?? ''
    return (
      <div key={question.question} className="agent-question-structured-item">
        <div className="agent-question-header">
          <span className="agent-question-header-chip">{question.header}</span>
          <span>{index + 1}. {question.question}{needsMultiHint(question) ? '（可多选）' : ''}</span>
        </div>
        <div className="agent-question-options">
          {question.options.map((option) => {
            const checked = question.multiSelect
              ? Array.isArray(value) && value.includes(option.label)
              : value === option.label
            return (
              <label key={option.label} className={`agent-question-option ${checked ? 'selected' : ''}`}>
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={question.question}
                  checked={checked}
                  onChange={() => question.multiSelect ? toggleMulti(question.question, option.label) : setSingle(question.question, option.label)}
                />
                <span className="agent-question-option-body">
                  <span className="agent-question-option-label">{option.label}</span>
                  <span className="agent-question-option-description">{option.description}</span>
                  {option.preview ? <pre className="agent-question-option-preview">{option.preview}</pre> : null}
                </span>
              </label>
            )
          })}
          <label
            className={`agent-question-option ${other.trim() || otherActive[question.question] ? 'selected' : ''}`}
            onClick={(e) => {
              if (e.target === otherInputRefs.current[question.question]) return
              toggleOther(question)
            }}
          >
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              name={question.question}
              checked={other.trim().length > 0 || Boolean(otherActive[question.question])}
              onChange={() => {}}
            />
            <span className="agent-question-option-body">
              <span className="agent-question-option-label">Other</span>
              <input
                ref={(node) => { otherInputRefs.current[question.question] = node }}
                className="agent-question-input"
                value={other}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => setOtherActive((prev) => ({ ...prev, [question.question]: true }))}
                onChange={(e) => {
                  setOtherActive((prev) => ({ ...prev, [question.question]: true }))
                  setOtherText((prev) => ({ ...prev, [question.question]: e.target.value }))
                }}
                placeholder="输入自定义答案…"
              />
            </span>
          </label>
        </div>
        <input
          className="agent-question-input"
          value={notes[question.question] ?? ''}
          onChange={(e) => setNotes((prev) => ({ ...prev, [question.question]: e.target.value }))}
          placeholder="可选备注…"
        />
      </div>
    )
  }

  return (
    <div className="agent-question-pending structured">
      <div className="agent-question-title">
        <span>需要你选择</span>
        {total > 1 ? <span className="agent-question-progress">{safeIndex + 1} / {total}</span> : null}
      </div>

      {renderQuestion(current, safeIndex)}

      <div className="agent-question-actions">
        {total > 1 ? (
          <div className="agent-question-pager">
            <button
              type="button"
              className="agent-question-cancel"
              disabled={safeIndex === 0}
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            >
              上一题
            </button>
            {!isLast ? (
              <button
                type="button"
                className="agent-question-submit"
                disabled={!currentAnswered}
                onClick={() => setPageIndex((i) => Math.min(total - 1, i + 1))}
              >
                下一题
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="agent-question-actions-right">
          {isLast ? (
            <button type="button" className="agent-question-submit" disabled={!canSubmit} onClick={submit}>提交答案</button>
          ) : null}
          <button type="button" className="agent-question-cancel" onClick={() => respond(msg.id, { answer: '', cancelled: true })}>取消</button>
        </div>
      </div>
    </div>
  )
}

export default function UserQuestionPrompt({ msg }: { msg: ChatMessageView }): JSX.Element {
  const respond = useAgentStore((s) => s.respondUserQuestion)
  const [answer, setAnswer] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const pending = msg.questionStatus === 'pending'

  const submit = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    respond(msg.id, { answer: trimmed })
  }

  
  const fillSuggestion = (value: string): void => {
    setAnswer(value)
    requestAnimationFrame(() => {
      const node = inputRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(value.length, value.length)
    })
  }

  if (!pending) {
    return (
      <div className={`agent-question-resolved ${msg.questionStatus ?? 'answered'}`}>
        <div className="agent-question-resolved-title">{msg.questionStatus === 'cancelled' ? '已取消' : '已回复'}</div>
        {msg.questionAnswers ? (
          <div className="agent-question-answer">
            {Object.entries(msg.questionAnswers).map(([question, value]) => (
              <div key={question}>{question} → {value}</div>
            ))}
          </div>
        ) : msg.questionAnswer ? <div className="agent-question-answer">{msg.questionAnswer}</div> : null}
      </div>
    )
  }

  if (msg.structuredQuestions?.length) {
    return <StructuredQuestionForm msg={msg} questions={msg.structuredQuestions} />
  }

  return (
    <div className="agent-question-pending">
      <div className="agent-question-title">需要你确认</div>
      {msg.questionPreviewImageId ? (
        <BrowserPreviewImage
          previewId={msg.questionPreviewImageId}
          className="agent-question-preview-img"
          alt="当前页面预览"
        />
      ) : null}
      <div className="agent-question-markdown">
        <MarkdownView text={msg.content} />
      </div>
      {msg.questionSuggestions?.length ? (
        <div className="agent-question-suggestions">
          {msg.questionSuggestions.map((s) => (
            <button key={s} type="button" className="agent-question-chip" onClick={() => fillSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="agent-question-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit(answer)
        }}
      >
        <input
          ref={inputRef}
          className="agent-question-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="输入你的回答…"
          autoFocus
        />
        <button type="submit" className="agent-question-submit" disabled={!answer.trim()}>
          发送
        </button>
        <button
          type="button"
          className="agent-question-cancel"
          onClick={() => respond(msg.id, { answer: '', cancelled: true })}
        >
          取消
        </button>
      </form>
    </div>
  )
}
