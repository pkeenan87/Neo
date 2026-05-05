'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  validateSkillId,
  skillContentByteLength,
  MAX_SKILL_CONTENT_BYTES,
} from '@/lib/skill-parser'
import sharedStyles from './SettingsPage.module.css'
import styles from './SkillsSection.module.css'

const DEFAULT_TEMPLATE = `# Skill: New Skill

## Description

One-paragraph summary of when this skill applies.

## Required Tools

- run_sentinel_kql

## Required Role

reader

## Parameters

- example_param

## Steps

### 1. First step

Describe the first investigation step.
`

interface SkillEditorPropsCreate {
  mode: 'create'
  onCancel: () => void
  onSaved: () => void
}

interface SkillEditorPropsEdit {
  mode: 'edit'
  skillId: string
  onCancel: () => void
  onSaved: () => void
}

type SkillEditorProps = SkillEditorPropsCreate | SkillEditorPropsEdit

export function SkillEditor(props: SkillEditorProps) {
  const isEdit = props.mode === 'edit'
  const [id, setId] = useState(isEdit ? props.skillId : '')
  const [content, setContent] = useState(isEdit ? '' : DEFAULT_TEMPLATE)
  const [loading, setLoading] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [idError, setIdError] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  // Hydrate the editor from the existing skill in edit mode.
  useEffect(() => {
    if (!isEdit) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/skills/${props.skillId}`)
        if (!res.ok) {
          setServerError('Failed to load skill')
          return
        }
        const data = await res.json()
        if (cancelled) return
        // GET returns the parsed Skill; we need the raw markdown to edit.
        // The route currently returns the parsed shape — fall back to
        // reconstructing from the parsed fields if rawMarkdown is absent.
        const raw = data.skill?.rawMarkdown
        if (typeof raw === 'string') {
          setContent(raw)
        } else if (data.skill) {
          setContent(reconstructMarkdownFromSkill(data.skill))
        }
      } catch {
        if (!cancelled) setServerError('Network error loading skill')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isEdit, props])

  const byteLength = useMemo(() => skillContentByteLength(content), [content])
  const overByteCap = byteLength > MAX_SKILL_CONTENT_BYTES
  const nearByteCap = byteLength > MAX_SKILL_CONTENT_BYTES * 0.8

  const handleSubmit = async () => {
    setIdError(null)
    setContentError(null)
    setServerError(null)

    if (!isEdit) {
      const idCheck = validateSkillId(id)
      if (idCheck) {
        setIdError(idCheck)
        return
      }
    }
    if (overByteCap) {
      setContentError(
        `Content is ${byteLength} bytes; maximum is ${MAX_SKILL_CONTENT_BYTES}.`,
      )
      return
    }

    setSubmitting(true)
    try {
      const res = isEdit
        ? await fetch(`/api/skills/${props.skillId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          })
        : await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, content }),
          })

      if (res.ok) {
        props.onSaved()
        return
      }

      const data = await res.json().catch(() => ({}))
      const message = typeof data.error === 'string' ? data.error : 'Save failed'

      if (res.status === 409) {
        setIdError(message)
      } else if (/id/i.test(message) && /required|character|hyphen/i.test(message)) {
        setIdError(message)
      } else {
        setServerError(message)
      }
    } catch {
      setServerError('Network error')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <p className={sharedStyles.keyStatusText}>Loading skill…</p>
  }

  return (
    <section className={sharedStyles.section}>
      <div className={styles.editorHeader}>
        <h2 className={styles.editorTitle}>
          {isEdit ? `Edit skill: ${props.skillId}` : 'New skill'}
        </h2>
      </div>

      <div className={styles.editorRoot}>
        <div className={sharedStyles.profileField}>
          <label htmlFor="skill-id" className={sharedStyles.fieldLabel}>
            ID {isEdit && <span className={sharedStyles.keyFieldHint}>(immutable)</span>}
          </label>
          <input
            id="skill-id"
            type="text"
            className={styles.idInput}
            value={id}
            readOnly={isEdit}
            onChange={(e) => setId(e.target.value)}
            placeholder="kebab-case-id"
            aria-invalid={idError !== null}
            aria-describedby={idError ? 'skill-id-error' : undefined}
          />
          {idError && (
            <p id="skill-id-error" className={styles.fieldError} role="alert">
              {idError}
            </p>
          )}
        </div>

        <div className={sharedStyles.profileField}>
          <label htmlFor="skill-content" className={sharedStyles.fieldLabel}>
            Markdown content
          </label>
          <textarea
            id="skill-content"
            className={styles.contentTextarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            aria-invalid={contentError !== null}
            aria-describedby={contentError ? 'skill-content-error' : undefined}
          />
          <p
            className={`${styles.byteCount} ${overByteCap ? styles.byteCountError : nearByteCap ? styles.byteCountWarn : ''}`}
            aria-live="polite"
          >
            {byteLength.toLocaleString()} / {MAX_SKILL_CONTENT_BYTES.toLocaleString()} bytes
          </p>
          {contentError && (
            <p id="skill-content-error" className={styles.fieldError} role="alert">
              {contentError}
            </p>
          )}
        </div>

        {serverError && (
          <p className={sharedStyles.keyFeedbackError} role="alert">
            {serverError}
          </p>
        )}

        <div className={styles.formActions}>
          <button type="button" className={styles.cancelButton} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={sharedStyles.saveButton}
            onClick={handleSubmit}
            disabled={submitting || overByteCap}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create skill'}
          </button>
        </div>
      </div>
    </section>
  )
}

// Used only as a fallback when GET /api/skills/[id] doesn't return
// rawMarkdown (legacy file-mode store path). Re-emits the canonical
// markdown shape so the parser round-trips for editing.
function reconstructMarkdownFromSkill(skill: {
  name?: string
  description?: string
  instructions?: string
  requiredTools?: string[]
  requiredRole?: string
  parameters?: string[]
}): string {
  const lines: string[] = []
  lines.push(`# Skill: ${skill.name ?? ''}`)
  lines.push('')
  lines.push('## Description')
  lines.push('')
  lines.push(skill.description ?? '')
  lines.push('')
  lines.push('## Required Tools')
  lines.push('')
  for (const t of skill.requiredTools ?? []) lines.push(`- ${t}`)
  lines.push('')
  lines.push('## Required Role')
  lines.push('')
  lines.push(skill.requiredRole ?? 'reader')
  lines.push('')
  lines.push('## Parameters')
  lines.push('')
  for (const p of skill.parameters ?? []) lines.push(`- ${p}`)
  lines.push('')
  lines.push('## Steps')
  lines.push('')
  lines.push(skill.instructions ?? '')
  lines.push('')
  return lines.join('\n')
}
