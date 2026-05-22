'use client'

import { useCallback, useEffect, useState } from 'react'

import sharedStyles from './SettingsPage.module.css'
import styles from './ScheduledTasksSection.module.css'

interface ScheduledTaskRunHistoryEntry {
  runId: string
  startTime: string
  endTime: string
  result: 'success' | 'failure' | 'timeout'
  outputSummary: string
  routedTo: string
  reason?: string
}

interface ScheduledTaskState {
  status: 'idle' | 'running' | 'failed'
  nextRunTime: string
  lastRunTime?: string
  lastRunResult?: 'success' | 'failure' | 'timeout'
  lastRunDurationMs?: number
  consecutiveFailures: number
}

interface ScheduledTask {
  id: string
  name: string
  description: string
  enabled: boolean
  dryRun: boolean
  schedule: { cronExpression: string; timezone: string }
  state: ScheduledTaskState
  runHistory: ScheduledTaskRunHistoryEntry[]
  _etag?: string
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function statusBadgeClass(state: ScheduledTaskState): string {
  if (state.status === 'running') return styles.badge_running
  if (state.status === 'failed') return styles.badge_failed
  if (state.lastRunResult === 'success') return styles.badge_success
  if (state.lastRunResult === 'timeout') return styles.badge_timeout
  return styles.badge_idle
}

function statusLabel(state: ScheduledTaskState): string {
  if (state.status === 'running') return 'running'
  if (state.status === 'failed') return 'breaker tripped'
  return state.lastRunResult ?? 'idle'
}

const DEFAULT_NEW_TASK = JSON.stringify(
  {
    name: 'Weekly lateral movement hunt',
    description:
      'Proactive cross-tenant lateral movement hunt. Notifies via the Information Security Incident Response Logic App Teams workflow on success.',
    enabled: false,
    dryRun: true,
    schedule: { cronExpression: '0 8 * * 1', timezone: 'America/New_York' },
    task: {
      promptTemplate:
        'Hunt for lateral movement across Defender and Sentinel for the last {{lookbackDays}} days. Summarize suspicious patterns by user and device.',
      variables: { lookbackDays: 7 },
      allowedTools: ['run_sentinel_kql', 'run_defender_hunting_query'],
      maxDurationSeconds: 120,
    },
    routing: {
      destination: 'tool',
      toolName: 'send_teams_message',
      fallbackDestination: 'cosmos-log',
    },
  },
  null,
  2,
)

export function ScheduledTasksSection() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createJson, setCreateJson] = useState(DEFAULT_NEW_TASK)
  const [createError, setCreateError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/scheduled-tasks')
      if (!res.ok) {
        setError(`Failed to load tasks (${res.status})`)
        setLoading(false)
        return
      }
      const data = await res.json()
      setTasks(data.tasks ?? [])
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchTasks()
  }, [fetchTasks])

  const handleToggleEnabled = useCallback(
    async (task: ScheduledTask) => {
      setBusyId(task.id)
      try {
        const res = await fetch(`/api/scheduled-tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedEtag: task._etag,
            enabled: !task.enabled,
          }),
        })
        if (!res.ok) {
          const body = await res.text()
          setError(`Failed to toggle: ${body}`)
        } else {
          await fetchTasks()
        }
      } finally {
        setBusyId(null)
      }
    },
    [fetchTasks],
  )

  const handleDelete = useCallback(
    async (task: ScheduledTask) => {
      if (!confirm(`Delete scheduled task "${task.name}"? This cannot be undone.`)) return
      setBusyId(task.id)
      try {
        const res = await fetch(`/api/scheduled-tasks/${task.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.text()
          setError(`Failed to delete: ${body}`)
        } else {
          if (expandedId === task.id) setExpandedId(null)
          await fetchTasks()
        }
      } finally {
        setBusyId(null)
      }
    },
    [fetchTasks, expandedId],
  )

  const handleRunNow = useCallback(
    async (task: ScheduledTask) => {
      setBusyId(task.id)
      try {
        const res = await fetch(`/api/scheduled-tasks/${task.id}/run`, {
          method: 'POST',
        })
        if (!res.ok && res.status !== 202) {
          const body = await res.text()
          setError(`Failed to trigger: ${body}`)
        } else {
          // Refetch after a short delay to give the background run time to start.
          setTimeout(() => void fetchTasks(), 1000)
        }
      } finally {
        setBusyId(null)
      }
    },
    [fetchTasks],
  )

  const handleCreate = useCallback(async () => {
    setCreateError(null)
    let payload: unknown
    try {
      payload = JSON.parse(createJson)
    } catch (err) {
      setCreateError(`Invalid JSON: ${(err as Error).message}`)
      return
    }
    try {
      const res = await fetch('/api/scheduled-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.text()
        setCreateError(`Server: ${body}`)
        return
      }
      setShowCreate(false)
      setCreateJson(DEFAULT_NEW_TASK)
      await fetchTasks()
    } catch (err) {
      setCreateError(`Network: ${(err as Error).message}`)
    }
  }, [createJson, fetchTasks])

  if (loading) {
    return (
      <section className={sharedStyles.section}>
        <h2 className={sharedStyles.sectionTitle}>Scheduled Tasks</h2>
        <p className={sharedStyles.keyStatusText}>Loading…</p>
      </section>
    )
  }

  return (
    <section className={sharedStyles.section}>
      <div className={styles.toolbar}>
        <h2 className={sharedStyles.sectionTitle}>Scheduled Tasks</h2>
        <button
          type="button"
          className={styles.newButton}
          onClick={() => setShowCreate(true)}
        >
          New task
        </button>
      </div>

      {error && <p className={sharedStyles.errorText}>{error}</p>}

      {tasks.length === 0 ? (
        <p className={styles.emptyState}>No scheduled tasks yet.</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableHeader}>Task</th>
                <th className={styles.tableHeader}>Schedule</th>
                <th className={styles.tableHeader}>Status</th>
                <th className={styles.tableHeader}>Next run</th>
                <th className={styles.tableHeader}>Failures</th>
                <th className={styles.tableHeader}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const isExpanded = expandedId === task.id
                const busy = busyId === task.id
                return (
                  <>
                    <tr key={task.id} className={styles.tableRow}>
                      <td className={styles.tableCell}>
                        <div className={styles.taskName}>{task.name}</div>
                        <div className={styles.taskDescription}>
                          {task.description}
                          {task.dryRun ? ' · dry-run' : ''}
                        </div>
                      </td>
                      <td className={styles.tableCell}>
                        <code>{task.schedule.cronExpression}</code>
                        <div className={styles.taskDescription}>
                          {task.schedule.timezone}
                        </div>
                      </td>
                      <td className={styles.tableCell}>
                        <span className={`${styles.badge} ${statusBadgeClass(task.state)}`}>
                          {statusLabel(task.state)}
                        </span>
                      </td>
                      <td className={styles.tableCell}>{formatDateTime(task.state.nextRunTime)}</td>
                      <td className={styles.tableCell}>{task.state.consecutiveFailures}</td>
                      <td className={styles.tableCell}>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className={styles.actionButton}
                            disabled={busy}
                            onClick={() => handleToggleEnabled(task)}
                          >
                            {task.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            className={styles.actionButton}
                            disabled={busy}
                            onClick={() => handleRunNow(task)}
                          >
                            Run now
                          </button>
                          <button
                            type="button"
                            className={styles.actionButton}
                            onClick={() => setExpandedId(isExpanded ? null : task.id)}
                          >
                            {isExpanded ? 'Hide' : 'History'}
                          </button>
                          <button
                            type="button"
                            className={`${styles.actionButton} ${styles.actionDanger}`}
                            disabled={busy}
                            onClick={() => handleDelete(task)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${task.id}-detail`}>
                        <td colSpan={6} className={styles.tableCell}>
                          <div className={styles.detailPanel}>
                            <div className={styles.detailHeader}>
                              <div className={styles.detailTitle}>Recent runs</div>
                              <div className={styles.taskDescription}>{task.runHistory.length} total</div>
                            </div>
                            {task.runHistory.length === 0 ? (
                              <p className={styles.emptyState}>No runs yet.</p>
                            ) : (
                              [...task.runHistory].reverse().map((run) => (
                                <div key={run.runId} className={styles.runRow}>
                                  <div className={styles.runMeta}>
                                    <span className={`${styles.badge} ${
                                      run.result === 'success'
                                        ? styles.badge_success
                                        : run.result === 'timeout'
                                          ? styles.badge_timeout
                                          : styles.badge_failed
                                    }`}>
                                      {run.result}
                                    </span>
                                    <span>{formatDateTime(run.startTime)}</span>
                                    <span>→ {run.routedTo}</span>
                                    {run.reason && <span>({run.reason})</span>}
                                  </div>
                                  {run.outputSummary && (
                                    <div className={styles.runSummary}>{run.outputSummary}</div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-label="Create scheduled task">
          <div className={styles.modalContent}>
            <h3 className={styles.modalTitle}>New scheduled task</h3>
            <p className={sharedStyles.keyFieldHintText}>
              Paste a JSON definition. New tasks start disabled — enable from the list once you have validated the dry-run output.
            </p>
            <textarea
              className={styles.jsonField}
              value={createJson}
              onChange={(e) => setCreateJson(e.target.value)}
              spellCheck={false}
            />
            {createError && <div className={styles.modalError}>{createError}</div>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => {
                  setShowCreate(false)
                  setCreateError(null)
                }}
              >
                Cancel
              </button>
              <button type="button" className={styles.newButton} onClick={handleCreate}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
