'use client'

import { useMemo, useState } from 'react'

import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  MAX_DURATION_SECONDS_CAP,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskDestination,
  type ScheduledTaskRouting,
  type UpdateScheduledTaskInput,
} from '@/lib/scheduled-task-types'
import {
  ROUTING_ALLOWED_TOOLS,
  VALID_DESTINATIONS,
  validateAuthShape,
  validateCircuitBreakerThreshold,
  validateRoutingShape,
  validateScheduleShape,
  validateTaskName,
  validateTaskShape,
} from '@/lib/scheduled-task-validators'
import { TOOL_NAMES } from '@/lib/skill-parser'
import { KeyValueList } from '@/components'

import sharedStyles from './SettingsPage.module.css'
import styles from './ScheduledTaskEditor.module.css'

interface ScheduledTaskEditorPropsCreate {
  mode: 'create'
  onCancel: () => void
  onSaved: () => void
}

interface ScheduledTaskEditorPropsEdit {
  mode: 'edit'
  task: ScheduledTask
  onCancel: () => void
  onSaved: () => void
}

type ScheduledTaskEditorProps = ScheduledTaskEditorPropsCreate | ScheduledTaskEditorPropsEdit

interface VariableRow {
  key: string
  value: string
}

interface FormState {
  name: string
  description: string
  enabled: boolean
  dryRun: boolean
  circuitBreakerThreshold: number | ''
  schedule: {
    cronExpression: string
    timezone: string
  }
  task: {
    promptTemplate: string
    variables: VariableRow[]
    allowedTools: string[]
    maxDurationSeconds: number | ''
  }
  routing: {
    destination: ScheduledTaskDestination
    teamsTeamId: string
    teamsChannelId: string
    emailTo: string
    toolName: string
    fallbackDestination: ScheduledTaskDestination | ''
  }
  auth: {
    scopedPermissions: string[]
    keyVaultSecretRefs: string[]
  }
}

const DEFAULT_NEW_FORM: FormState = {
  name: 'Weekly lateral movement hunt',
  description:
    'Proactive cross-tenant lateral movement hunt. Notifies via the Information Security Incident Response Logic App Teams workflow on success.',
  enabled: false,
  dryRun: true,
  circuitBreakerThreshold: DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  schedule: {
    cronExpression: '0 8 * * 1',
    timezone: 'America/New_York',
  },
  task: {
    promptTemplate:
      'Hunt for lateral movement across Defender and Sentinel for the last {{lookbackDays}} days. Summarize suspicious patterns by user and device.',
    variables: [{ key: 'lookbackDays', value: '7' }],
    allowedTools: ['run_sentinel_kql', 'run_defender_hunting_query'],
    maxDurationSeconds: 120,
  },
  routing: {
    destination: 'tool',
    teamsTeamId: '',
    teamsChannelId: '',
    emailTo: '',
    toolName: 'send_teams_message',
    fallbackDestination: 'cosmos-log',
  },
  auth: {
    scopedPermissions: [],
    keyVaultSecretRefs: [],
  },
}

function taskToFormState(task: ScheduledTask): FormState {
  const variables: VariableRow[] = task.task.variables
    ? Object.entries(task.task.variables).map(([key, value]) => ({
        key,
        value: String(value),
      }))
    : []

  return {
    name: task.name,
    description: task.description,
    enabled: task.enabled,
    dryRun: task.dryRun,
    circuitBreakerThreshold:
      typeof task.circuitBreakerThreshold === 'number'
        ? task.circuitBreakerThreshold
        : DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
    schedule: {
      cronExpression: task.schedule.cronExpression,
      timezone: task.schedule.timezone,
    },
    task: {
      promptTemplate: task.task.promptTemplate,
      variables,
      allowedTools: task.task.allowedTools,
      maxDurationSeconds: task.task.maxDurationSeconds,
    },
    routing: {
      destination: task.routing.destination,
      teamsTeamId: task.routing.teamsTeamId ?? '',
      teamsChannelId: task.routing.teamsChannelId ?? '',
      emailTo: task.routing.emailTo ?? '',
      toolName: task.routing.toolName ?? '',
      fallbackDestination: task.routing.fallbackDestination ?? '',
    },
    auth: {
      scopedPermissions: task.auth?.scopedPermissions ?? [],
      keyVaultSecretRefs: task.auth?.keyVaultSecretRefs ?? [],
    },
  }
}

function variablesToRecord(rows: VariableRow[]): Record<string, string> | undefined {
  const cleaned = rows.filter((r) => r.key.trim() !== '')
  if (cleaned.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const row of cleaned) out[row.key.trim()] = row.value
  return out
}

/**
 * Build the routing object the validators expect. Empty conditional
 * fields are dropped rather than serialized as empty strings so
 * validateRoutingShape's `!s.cronExpression.trim()`-style guards don't
 * spuriously fire on values the user never touched.
 */
function buildRouting(routing: FormState['routing']): ScheduledTaskRouting {
  const r: ScheduledTaskRouting = { destination: routing.destination }
  if (routing.destination === 'teams-channel') {
    if (routing.teamsTeamId.trim()) r.teamsTeamId = routing.teamsTeamId.trim()
    if (routing.teamsChannelId.trim()) r.teamsChannelId = routing.teamsChannelId.trim()
  }
  if (routing.destination === 'tool') {
    if (routing.toolName.trim()) r.toolName = routing.toolName.trim()
  }
  if (routing.destination === 'email') {
    if (routing.emailTo.trim()) r.emailTo = routing.emailTo.trim()
  }
  if (routing.fallbackDestination !== '') {
    r.fallbackDestination = routing.fallbackDestination
    if (routing.fallbackDestination === 'teams-channel') {
      if (routing.teamsTeamId.trim()) r.teamsTeamId = routing.teamsTeamId.trim()
      if (routing.teamsChannelId.trim()) r.teamsChannelId = routing.teamsChannelId.trim()
    }
  }
  return r
}

function formToCreatePayload(form: FormState): CreateScheduledTaskInput {
  return {
    name: form.name.trim(),
    description: form.description,
    enabled: form.enabled,
    dryRun: form.dryRun,
    circuitBreakerThreshold:
      typeof form.circuitBreakerThreshold === 'number'
        ? form.circuitBreakerThreshold
        : DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
    schedule: { ...form.schedule },
    task: {
      promptTemplate: form.task.promptTemplate,
      variables: variablesToRecord(form.task.variables),
      allowedTools: form.task.allowedTools,
      maxDurationSeconds:
        typeof form.task.maxDurationSeconds === 'number' ? form.task.maxDurationSeconds : 0,
    },
    routing: buildRouting(form.routing),
    auth:
      form.auth.scopedPermissions.length || form.auth.keyVaultSecretRefs.length
        ? {
            executionIdentity: 'managed-identity',
            scopedPermissions: form.auth.scopedPermissions,
            keyVaultSecretRefs: form.auth.keyVaultSecretRefs,
          }
        : undefined,
  }
}

function formToUpdatePayload(form: FormState, expectedEtag: string): UpdateScheduledTaskInput {
  const base = formToCreatePayload(form)
  return {
    ...base,
    expectedEtag,
  }
}

const SORTED_TOOL_OPTIONS = Array.from(TOOL_NAMES).sort()
const ROUTING_TOOL_OPTIONS = Array.from(ROUTING_ALLOWED_TOOLS).sort()

interface FieldErrors {
  name?: string
  schedule?: string
  task?: string
  routing?: string
  auth?: string
  circuitBreaker?: string
  jsonView?: string
}

export function ScheduledTaskEditor(props: ScheduledTaskEditorProps) {
  const isEdit = props.mode === 'edit'
  const [form, setForm] = useState<FormState>(
    isEdit ? taskToFormState(props.task) : DEFAULT_NEW_FORM,
  )
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [toolToAdd, setToolToAdd] = useState('')
  const [view, setView] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [authOpen, setAuthOpen] = useState(false)

  const availableTools = useMemo(
    () => SORTED_TOOL_OPTIONS.filter((t) => !form.task.allowedTools.includes(t)),
    [form.task.allowedTools],
  )

  function patchForm(updater: (prev: FormState) => FormState) {
    setForm((prev) => updater(prev))
  }

  function toggleView() {
    if (view === 'form') {
      setJsonText(JSON.stringify(formToCreatePayload(form), null, 2))
      setView('json')
    } else {
      try {
        const parsed = JSON.parse(jsonText) as CreateScheduledTaskInput
        // Synthesize a ScheduledTask-ish shape so taskToFormState can
        // hydrate the form; missing fields fall back to current values.
        const reconstructed: ScheduledTask = {
          id: isEdit ? props.task.id : '',
          createdBy: '',
          name: parsed.name ?? form.name,
          description: parsed.description ?? form.description,
          enabled: parsed.enabled ?? form.enabled,
          dryRun: parsed.dryRun ?? form.dryRun,
          circuitBreakerThreshold:
            parsed.circuitBreakerThreshold ??
            (typeof form.circuitBreakerThreshold === 'number'
              ? form.circuitBreakerThreshold
              : DEFAULT_CIRCUIT_BREAKER_THRESHOLD),
          schedule: parsed.schedule ?? form.schedule,
          task: parsed.task ?? {
            promptTemplate: form.task.promptTemplate,
            allowedTools: form.task.allowedTools,
            maxDurationSeconds:
              typeof form.task.maxDurationSeconds === 'number' ? form.task.maxDurationSeconds : 0,
            variables: variablesToRecord(form.task.variables),
          },
          routing: parsed.routing ?? buildRouting(form.routing),
          auth: {
            executionIdentity: 'managed-identity',
            scopedPermissions: parsed.auth?.scopedPermissions ?? form.auth.scopedPermissions,
            keyVaultSecretRefs: parsed.auth?.keyVaultSecretRefs ?? form.auth.keyVaultSecretRefs,
          },
          state: { status: 'idle', nextRunTime: '', consecutiveFailures: 0 },
          runHistory: [],
          createdAt: '',
          updatedAt: '',
        }
        setForm(taskToFormState(reconstructed))
        setErrors((prev) => ({ ...prev, jsonView: undefined }))
        setView('form')
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          jsonView: `Invalid JSON: ${(err as Error).message}`,
        }))
      }
    }
  }

  function runValidators(payload: CreateScheduledTaskInput): FieldErrors {
    const e: FieldErrors = {}
    const nameErr = validateTaskName(payload.name)
    if (nameErr) e.name = nameErr
    const scheduleErr = validateScheduleShape(payload.schedule)
    if (scheduleErr) e.schedule = scheduleErr
    const taskErr = validateTaskShape(payload.task)
    if (taskErr) e.task = taskErr
    const routingErr = validateRoutingShape(payload.routing)
    if (routingErr) e.routing = routingErr
    const authErr = validateAuthShape(payload.auth)
    if (authErr) e.auth = authErr
    const cbtErr = validateCircuitBreakerThreshold(payload.circuitBreakerThreshold)
    if (cbtErr) e.circuitBreaker = cbtErr
    return e
  }

  async function handleSubmit() {
    setServerError(null)
    setErrors({})

    // If we're in JSON view, attempt to sync back to form first.
    if (view === 'json') {
      try {
        JSON.parse(jsonText)
      } catch (err) {
        setErrors({ jsonView: `Invalid JSON: ${(err as Error).message}` })
        return
      }
    }

    const payload = view === 'json' ? (JSON.parse(jsonText) as CreateScheduledTaskInput) : formToCreatePayload(form)
    const validationErrors = runValidators(payload)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    setSubmitting(true)
    try {
      const res = isEdit
        ? await fetch(`/api/scheduled-tasks/${props.task.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              view === 'json'
                ? { ...(payload as CreateScheduledTaskInput), expectedEtag: props.task._etag ?? '' }
                : formToUpdatePayload(form, props.task._etag ?? ''),
            ),
          })
        : await fetch('/api/scheduled-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      if (!res.ok) {
        const body = await res.text()
        setServerError(`Server (${res.status}): ${body}`)
        return
      }
      props.onSaved()
    } catch (err) {
      setServerError(`Network: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.editorRoot}>
      <div className={styles.editorHeader}>
        <h3 className={styles.editorTitle}>
          {isEdit ? `Edit task: ${props.task.name}` : 'New scheduled task'}
        </h3>
        <button
          type="button"
          className={styles.viewToggle}
          onClick={toggleView}
          aria-pressed={view === 'json'}
        >
          {view === 'form' ? 'Switch to JSON view' : 'Switch to form view'}
        </button>
      </div>

      {view === 'json' ? (
        <div className={sharedStyles.profileField}>
          <label htmlFor="task-json" className={sharedStyles.fieldLabel}>
            JSON payload (advanced)
          </label>
          <textarea
            id="task-json"
            className={styles.jsonField}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
          />
          {errors.jsonView && (
            <p className={styles.fieldError} role="alert">
              {errors.jsonView}
            </p>
          )}
        </div>
      ) : (
        <>
          <fieldset className={styles.fieldGroup}>
            <legend className={styles.groupLegend}>Identity</legend>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-name" className={sharedStyles.fieldLabel}>
                Name
              </label>
              <input
                id="task-name"
                type="text"
                className={styles.textInput}
                value={form.name}
                onChange={(e) => patchForm((p) => ({ ...p, name: e.target.value }))}
                aria-required="true"
                aria-invalid={errors.name !== undefined}
              />
              {errors.name && (
                <p className={styles.fieldError} role="alert">
                  {errors.name}
                </p>
              )}
            </div>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-description" className={sharedStyles.fieldLabel}>
                Description
              </label>
              <textarea
                id="task-description"
                className={styles.shortTextarea}
                value={form.description}
                onChange={(e) => patchForm((p) => ({ ...p, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className={styles.checkboxRow}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => patchForm((p) => ({ ...p, enabled: e.target.checked }))}
                />
                Enabled
              </label>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={form.dryRun}
                  onChange={(e) => patchForm((p) => ({ ...p, dryRun: e.target.checked }))}
                />
                Dry run
              </label>
            </div>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-cbt" className={sharedStyles.fieldLabel}>
                Circuit breaker threshold
              </label>
              <input
                id="task-cbt"
                type="number"
                min={1}
                className={styles.numberInput}
                value={form.circuitBreakerThreshold}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    circuitBreakerThreshold:
                      e.target.value === '' ? '' : Number(e.target.value),
                  }))
                }
                aria-invalid={errors.circuitBreaker !== undefined}
              />
              {errors.circuitBreaker && (
                <p className={styles.fieldError} role="alert">
                  {errors.circuitBreaker}
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className={styles.fieldGroup}>
            <legend className={styles.groupLegend}>Schedule</legend>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-cron" className={sharedStyles.fieldLabel}>
                Cron expression
              </label>
              <input
                id="task-cron"
                type="text"
                className={styles.textInput}
                value={form.schedule.cronExpression}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    schedule: { ...p.schedule, cronExpression: e.target.value },
                  }))
                }
                placeholder="0 8 * * 1"
                aria-required="true"
              />
            </div>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-timezone" className={sharedStyles.fieldLabel}>
                Timezone (IANA)
              </label>
              <input
                id="task-timezone"
                type="text"
                className={styles.textInput}
                value={form.schedule.timezone}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    schedule: { ...p.schedule, timezone: e.target.value },
                  }))
                }
                placeholder="America/New_York"
                aria-required="true"
              />
            </div>
            {errors.schedule && (
              <p className={styles.fieldError} role="alert">
                {errors.schedule}
              </p>
            )}
          </fieldset>

          <fieldset className={styles.fieldGroup}>
            <legend className={styles.groupLegend}>Task context</legend>
            <div className={sharedStyles.profileField}>
              <label htmlFor="task-prompt" className={sharedStyles.fieldLabel}>
                Prompt template
              </label>
              <textarea
                id="task-prompt"
                className={styles.longTextarea}
                value={form.task.promptTemplate}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    task: { ...p.task, promptTemplate: e.target.value },
                  }))
                }
                rows={4}
                placeholder="Use {{variable}} placeholders for templated values."
              />
              <p className={styles.fieldHint}>
                Use <code>{`{{variable}}`}</code> placeholders for templated values.
              </p>
            </div>

            <div className={sharedStyles.profileField}>
              <label className={sharedStyles.fieldLabel}>Variables</label>
              <KeyValueList
                entries={form.task.variables}
                onChange={(entries) =>
                  patchForm((p) => ({
                    ...p,
                    task: { ...p.task, variables: entries },
                  }))
                }
                keyLabel="Variable"
                valueLabel="Variable value"
                addLabel="Add variable"
                emptyLabel="No variables defined."
              />
              <p className={styles.fieldHint}>
                Values are sent as strings; the agent coerces inside the prompt as needed.
              </p>
            </div>

            <fieldset className={styles.nestedGroup}>
              <legend className={sharedStyles.fieldLabel}>Allowed tools</legend>
              {form.task.allowedTools.length === 0 && (
                <p className={styles.fieldHint}>No tools selected.</p>
              )}
              {form.task.allowedTools.length > 0 && (
                <ul className={styles.chipList}>
                  {form.task.allowedTools.map((tool) => (
                    <li key={tool} className={styles.chip}>
                      <span>{tool}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={`Remove ${tool}`}
                        onClick={() =>
                          patchForm((p) => ({
                            ...p,
                            task: {
                              ...p.task,
                              allowedTools: p.task.allowedTools.filter((t) => t !== tool),
                            },
                          }))
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.inlineRow}>
                <label htmlFor="task-tool-add" className={styles.srOnly}>
                  Add an allowed tool
                </label>
                <select
                  id="task-tool-add"
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
                  disabled={!toolToAdd}
                  onClick={() => {
                    if (!toolToAdd) return
                    patchForm((p) => ({
                      ...p,
                      task: {
                        ...p.task,
                        allowedTools: [...p.task.allowedTools, toolToAdd],
                      },
                    }))
                    setToolToAdd('')
                  }}
                >
                  Add
                </button>
              </div>
            </fieldset>

            <div className={sharedStyles.profileField}>
              <label htmlFor="task-duration" className={sharedStyles.fieldLabel}>
                Max duration (seconds)
              </label>
              <input
                id="task-duration"
                type="number"
                min={1}
                max={MAX_DURATION_SECONDS_CAP}
                className={styles.numberInput}
                value={form.task.maxDurationSeconds}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    task: {
                      ...p.task,
                      maxDurationSeconds:
                        e.target.value === '' ? '' : Number(e.target.value),
                    },
                  }))
                }
              />
              <p className={styles.fieldHint}>Cap is {MAX_DURATION_SECONDS_CAP} seconds.</p>
            </div>

            {errors.task && (
              <p className={styles.fieldError} role="alert">
                {errors.task}
              </p>
            )}
          </fieldset>

          <fieldset className={styles.fieldGroup}>
            <legend className={styles.groupLegend}>Routing</legend>
            <div className={sharedStyles.profileField}>
              <label htmlFor="routing-destination" className={sharedStyles.fieldLabel}>
                Destination
              </label>
              <select
                id="routing-destination"
                className={styles.select}
                value={form.routing.destination}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      destination: e.target.value as ScheduledTaskDestination,
                    },
                  }))
                }
              >
                {VALID_DESTINATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            {(form.routing.destination === 'teams-channel' ||
              form.routing.fallbackDestination === 'teams-channel') && (
              <>
                <div className={sharedStyles.profileField}>
                  <label htmlFor="routing-team-id" className={sharedStyles.fieldLabel}>
                    Teams team ID
                  </label>
                  <input
                    id="routing-team-id"
                    type="text"
                    className={styles.textInput}
                    value={form.routing.teamsTeamId}
                    onChange={(e) =>
                      patchForm((p) => ({
                        ...p,
                        routing: { ...p.routing, teamsTeamId: e.target.value },
                      }))
                    }
                  />
                </div>
                <div className={sharedStyles.profileField}>
                  <label htmlFor="routing-channel-id" className={sharedStyles.fieldLabel}>
                    Teams channel ID
                  </label>
                  <input
                    id="routing-channel-id"
                    type="text"
                    className={styles.textInput}
                    value={form.routing.teamsChannelId}
                    onChange={(e) =>
                      patchForm((p) => ({
                        ...p,
                        routing: { ...p.routing, teamsChannelId: e.target.value },
                      }))
                    }
                  />
                </div>
              </>
            )}

            {form.routing.destination === 'email' && (
              <div className={sharedStyles.profileField}>
                <label htmlFor="routing-email-to" className={sharedStyles.fieldLabel}>
                  Email recipient
                </label>
                <input
                  id="routing-email-to"
                  type="email"
                  className={styles.textInput}
                  value={form.routing.emailTo}
                  onChange={(e) =>
                    patchForm((p) => ({
                      ...p,
                      routing: { ...p.routing, emailTo: e.target.value },
                    }))
                  }
                />
              </div>
            )}

            {form.routing.destination === 'tool' && (
              <div className={sharedStyles.profileField}>
                <label htmlFor="routing-tool-name" className={sharedStyles.fieldLabel}>
                  Tool name
                </label>
                <select
                  id="routing-tool-name"
                  className={styles.select}
                  value={form.routing.toolName}
                  onChange={(e) =>
                    patchForm((p) => ({
                      ...p,
                      routing: { ...p.routing, toolName: e.target.value },
                    }))
                  }
                >
                  <option value="">— select —</option>
                  {ROUTING_TOOL_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className={sharedStyles.profileField}>
              <label htmlFor="routing-fallback" className={sharedStyles.fieldLabel}>
                Fallback destination (optional)
              </label>
              <select
                id="routing-fallback"
                className={styles.select}
                value={form.routing.fallbackDestination}
                onChange={(e) =>
                  patchForm((p) => ({
                    ...p,
                    routing: {
                      ...p.routing,
                      fallbackDestination: e.target.value as
                        | ScheduledTaskDestination
                        | '',
                    },
                  }))
                }
              >
                <option value="">— none —</option>
                {VALID_DESTINATIONS.filter((d) => d !== 'tool').map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            {errors.routing && (
              <p className={styles.fieldError} role="alert">
                {errors.routing}
              </p>
            )}
          </fieldset>

          <details
            className={styles.collapsible}
            open={authOpen}
            onToggle={(e) => setAuthOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className={styles.collapsibleSummary}>Advanced — auth</summary>
            <div className={styles.collapsibleBody}>
              <div className={sharedStyles.profileField}>
                <label className={sharedStyles.fieldLabel}>Scoped permissions</label>
                <textarea
                  className={styles.shortTextarea}
                  rows={2}
                  value={form.auth.scopedPermissions.join('\n')}
                  onChange={(e) =>
                    patchForm((p) => ({
                      ...p,
                      auth: {
                        ...p.auth,
                        scopedPermissions: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                  placeholder="One permission per line"
                />
              </div>
              <div className={sharedStyles.profileField}>
                <label className={sharedStyles.fieldLabel}>Key Vault secret refs</label>
                <textarea
                  className={styles.shortTextarea}
                  rows={2}
                  value={form.auth.keyVaultSecretRefs.join('\n')}
                  onChange={(e) =>
                    patchForm((p) => ({
                      ...p,
                      auth: {
                        ...p.auth,
                        keyVaultSecretRefs: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                  placeholder="One secret URI per line"
                />
              </div>
              {errors.auth && (
                <p className={styles.fieldError} role="alert">
                  {errors.auth}
                </p>
              )}
            </div>
          </details>
        </>
      )}

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
          className={styles.saveButton}
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </div>
  )
}
