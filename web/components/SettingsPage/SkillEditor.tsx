'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
  // Capture skillId as a primitive so useEffect / useMemo can depend
  // on the value, not the whole props object. The parent passes
  // inline arrow callbacks for onCancel / onSaved (a deliberate
  // pattern for keying behaviour to the row being edited), so the
  // props object identity churns on every parent render. Depending
  // on the primitive avoids hydration-fetch storms that would
  // otherwise overwrite in-progress form edits when an ancestor
  // re-renders (e.g. the SkillsSection cacheHintUntil 15s timer).
  const skillId = isEdit ? props.skillId : null
  const [id, setId] = useState(isEdit ? props.skillId : '')
  const [form, setForm] = useState<SkillFormState>(DEFAULT_FORM_STATE)
  // Edit mode starts unhydrated; create mode is hydrated immediately.
  // Save and the form body are gated on `hydrated || !isEdit` so a
  // failed GET cannot leave the form populated with new-skill
  // defaults that a click on Save would silently PUT over the real
  // skill.
  const [hydrated, setHydrated] = useState(!isEdit)
  const [loading, setLoading] = useState(isEdit)
  const [submitting, setSubmitting] = useState(false)
  const [idError, setIdError] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [toolToAdd, setToolToAdd] = useState<string>('')

  // Synchronous re-entry gate for handleSubmit. React's `disabled` is
  // committed asynchronously, so a fast double-click can fire two
  // submits before the disabled state lands. The ref blocks the
  // second entry before any await.
  const submitInFlightRef = useRef(false)
  // Tracks whether the component is still mounted so async settlers
  // skip setState / props.onSaved after unmount. Paired with the
  // AbortController in each fetch so the request is also aborted.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Hydrate from the existing skill in edit mode. GET /api/skills/[id]
  // returns the parsed Skill, so we drop straight into form state with
  // no markdown round-trip required on load. Deps are scoped to the
  // primitive skillId — never the whole props object — so callback
  // identity churn in the parent doesn't refire the fetch.
  useEffect(() => {
    if (!isEdit || skillId === null) return
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`/api/skills/${skillId}`, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (!res.ok) {
          setServerError('Failed to load skill')
          return
        }
        const data = await res.json()
        if (controller.signal.aborted) return
        if (data.skill) {
          setForm(skillToFormState(data.skill as Skill))
          setHydrated(true)
        } else {
          // 200 OK but missing skill payload — refuse to render the
          // form (else DEFAULT_FORM_STATE leaks into a PUT).
          setServerError('Skill data missing from server response')
        }
      } catch (err) {
        if (controller.signal.aborted) return
        if ((err as DOMException)?.name === 'AbortError') return
        setServerError('Network error loading skill')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => {
      controller.abort()
    }
  }, [isEdit, skillId])

  const serialized = useMemo(
    () =>
      serializeSkillMarkdown({
        id: skillId ?? id ?? 'pending',
        ...form,
      }),
    [form, id, skillId],
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
    // Synchronous re-entry gate — React commits `disabled` asynchronously
    // so a fast double-click can land two handleSubmit calls before the
    // button's disabled attribute renders. The ref blocks the second.
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true

    setIdError(null)
    setContentError(null)
    setServerError(null)

    if (!isEdit) {
      const idCheck = validateSkillId(id)
      if (idCheck) {
        setIdError(idCheck)
        submitInFlightRef.current = false
        return
      }
    }
    if (overByteCap) {
      setContentError(
        `Content is ${byteLength} bytes; maximum is ${MAX_SKILL_CONTENT_BYTES}.`,
      )
      submitInFlightRef.current = false
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
    const controller = new AbortController()
    try {
      const res = isEdit
        ? await fetch(`/api/skills/${props.skillId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
            signal: controller.signal,
          })
        : await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, content }),
            signal: controller.signal,
          })

      if (!mountedRef.current) return

      if (res.ok) {
        // Hand off to the parent OUTSIDE the catch so a throw in the
        // parent's handler doesn't get re-classified as 'Network error'.
        // We've already returned a successful response — anything that
        // happens in the parent is its own concern.
        props.onSaved()
        return
      }

      const data = await res.json().catch(() => ({}))
      if (!mountedRef.current) return
      const message = typeof data.error === 'string' ? data.error : 'Save failed'

      if (res.status === 409) {
        setIdError(message)
      } else if (/id/i.test(message) && /required|character|hyphen/i.test(message)) {
        setIdError(message)
      } else {
        setServerError(message)
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return
      if (mountedRef.current) setServerError('Network error')
    } finally {
      if (mountedRef.current) setSubmitting(false)
      submitInFlightRef.current = false
    }
  }

  if (loading) {
    return <p className={sharedStyles.keyStatusText}>Loading skill…</p>
  }

  // In edit mode, refuse to render the form body when hydration
  // failed. The form is otherwise pre-filled with DEFAULT_FORM_STATE
  // (the new-skill template), and a click on Save would PUT those
  // defaults over the real skill. Surface the error and a Cancel
  // affordance only.
  if (isEdit && !hydrated) {
    return (
      <section className={sharedStyles.section}>
        <div className={styles.editorHeader}>
          <h2 className={styles.editorTitle}>Edit skill: {props.skillId}</h2>
        </div>
        <p className={sharedStyles.keyFeedbackError} role="alert">
          {serverError ?? 'Could not load skill — refresh the list and try again.'}
        </p>
        <div className={styles.formActions}>
          <button type="button" className={styles.cancelButton} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </section>
    )
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
