'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_SKILL,
  MAX_SKILL_CONTENT_BYTES,
  TOOL_NAMES,
  serializeSkillMarkdown,
  skillContentByteLength,
  validateSkillId,
} from '@/lib/skill-parser'
import type { Skill } from '@/lib/types'
import type { Role } from '@/lib/permissions'
import sharedStyles from './SettingsPage.module.css'
import styles from './SkillsSection.module.css'

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

interface SkillFormState {
  name: string
  description: string
  instructions: string
  requiredTools: string[]
  requiredRole: Role
  parameters: string[]
}

function skillToFormState(skill: Skill): SkillFormState {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    requiredTools: skill.requiredTools,
    requiredRole: skill.requiredRole,
    parameters: skill.parameters,
  }
}

const DEFAULT_FORM_STATE: SkillFormState = skillToFormState(DEFAULT_SKILL)

const SORTED_TOOL_OPTIONS: string[] = Array.from(TOOL_NAMES).sort()

export function SkillEditor(props: SkillEditorProps) {
  const isEdit = props.mode === 'edit'
  const [id, setId] = useState(isEdit ? props.skillId : '')
  const [form, setForm] = useState<SkillFormState>(DEFAULT_FORM_STATE)
  const [loading, setLoading] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [idError, setIdError] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [toolToAdd, setToolToAdd] = useState<string>('')

  // Hydrate from the existing skill in edit mode. GET /api/skills/[id]
  // returns the parsed Skill, so we drop straight into form state with
  // no markdown round-trip required on load.
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
        if (data.skill) {
          setForm(skillToFormState(data.skill as Skill))
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

  const serialized = useMemo(
    () =>
      serializeSkillMarkdown({
        id: isEdit ? props.skillId : id || 'pending',
        ...form,
      }),
    [form, id, isEdit, props],
  )
  const byteLength = useMemo(() => skillContentByteLength(serialized), [serialized])
  const overByteCap = byteLength > MAX_SKILL_CONTENT_BYTES
  const nearByteCap = byteLength > MAX_SKILL_CONTENT_BYTES * 0.8

  const availableTools = useMemo(
    () => SORTED_TOOL_OPTIONS.filter((t) => !form.requiredTools.includes(t)),
    [form.requiredTools],
  )

  function updateForm<K extends keyof SkillFormState>(key: K, value: SkillFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function addTool(name: string) {
    if (!name || form.requiredTools.includes(name)) return
    updateForm('requiredTools', [...form.requiredTools, name])
    setToolToAdd('')
  }

  function removeTool(name: string) {
    updateForm(
      'requiredTools',
      form.requiredTools.filter((t) => t !== name),
    )
  }

  function updateParameter(index: number, value: string) {
    const next = [...form.parameters]
    next[index] = value
    updateForm('parameters', next)
  }

  function removeParameter(index: number) {
    updateForm(
      'parameters',
      form.parameters.filter((_, i) => i !== index),
    )
  }

  function addParameter() {
    updateForm('parameters', [...form.parameters, ''])
  }

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

    // Drop empty parameter rows before serializing — the parser would
    // skip them on read anyway, so persisting them just inflates the
    // byte count and confuses the diff.
    const cleanedParameters = form.parameters.map((p) => p.trim()).filter(Boolean)

    const finalSkill: Skill = {
      id: isEdit ? props.skillId : id,
      name: form.name,
      description: form.description,
      instructions: form.instructions,
      requiredTools: form.requiredTools,
      requiredRole: form.requiredRole,
      parameters: cleanedParameters,
    }
    const content = serializeSkillMarkdown(finalSkill)

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
            aria-required={!isEdit}
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
          <label htmlFor="skill-name" className={sharedStyles.fieldLabel}>
            Name
          </label>
          <input
            id="skill-name"
            type="text"
            className={styles.textInput}
            value={form.name}
            onChange={(e) => updateForm('name', e.target.value)}
            placeholder="Human-readable title"
            aria-required="true"
          />
        </div>

        <div className={sharedStyles.profileField}>
          <label htmlFor="skill-description" className={sharedStyles.fieldLabel}>
            Description
          </label>
          <textarea
            id="skill-description"
            className={styles.shortTextarea}
            value={form.description}
            onChange={(e) => updateForm('description', e.target.value)}
            rows={3}
            placeholder="One paragraph: when does this skill apply?"
            aria-required="true"
          />
        </div>

        <fieldset className={styles.fieldGroup}>
          <legend className={sharedStyles.fieldLabel}>Required Tools</legend>
          {form.requiredTools.length === 0 && (
            <p className={styles.fieldHint}>No tools selected yet.</p>
          )}
          {form.requiredTools.length > 0 && (
            <ul className={styles.chipList}>
              {form.requiredTools.map((tool) => (
                <li key={tool} className={styles.chip}>
                  <span className={styles.chipLabel}>{tool}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => removeTool(tool)}
                    aria-label={`Remove ${tool}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.inlineRow}>
            <label htmlFor="skill-tool-add" className={styles.srOnly}>
              Add a tool
            </label>
            <select
              id="skill-tool-add"
              className={styles.select}
              value={toolToAdd}
              onChange={(e) => setToolToAdd(e.target.value)}
            >
              <option value="">Add a tool…</option>
              {availableTools.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.inlineAddButton}
              onClick={() => addTool(toolToAdd)}
              disabled={!toolToAdd}
            >
              Add
            </button>
          </div>
        </fieldset>

        <div className={sharedStyles.profileField}>
          <label htmlFor="skill-role" className={sharedStyles.fieldLabel}>
            Required Role
          </label>
          <select
            id="skill-role"
            className={styles.select}
            value={form.requiredRole}
            onChange={(e) => updateForm('requiredRole', e.target.value as Role)}
          >
            <option value="reader">reader</option>
            <option value="admin">admin</option>
          </select>
        </div>

        <fieldset className={styles.fieldGroup}>
          <legend className={sharedStyles.fieldLabel}>Parameters</legend>
          {form.parameters.length === 0 && (
            <p className={styles.fieldHint}>No parameters defined.</p>
          )}
          {form.parameters.map((param, index) => (
            <div key={index} className={styles.inlineRow}>
              <label htmlFor={`skill-param-${index}`} className={styles.srOnly}>
                Parameter {index + 1}
              </label>
              <input
                id={`skill-param-${index}`}
                type="text"
                className={styles.textInput}
                value={param}
                onChange={(e) => updateParameter(index, e.target.value)}
                placeholder="parameter_name"
              />
              <button
                type="button"
                className={styles.inlineRemoveButton}
                onClick={() => removeParameter(index)}
                aria-label={`Remove parameter ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" className={styles.inlineAddButton} onClick={addParameter}>
            Add parameter
          </button>
        </fieldset>

        <div className={sharedStyles.profileField}>
          <label htmlFor="skill-steps" className={sharedStyles.fieldLabel}>
            Steps
          </label>
          <textarea
            id="skill-steps"
            className={styles.contentTextarea}
            value={form.instructions}
            onChange={(e) => updateForm('instructions', e.target.value)}
            spellCheck={false}
            placeholder="Use Markdown. ### 1. Step name on its own line, then the body."
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
