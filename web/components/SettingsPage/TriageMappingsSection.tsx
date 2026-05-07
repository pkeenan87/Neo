'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { SkillMeta, TriageMapping } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
import { MappingDeleteConfirmModal } from './MappingDeleteConfirmModal'
import sharedStyles from './SettingsPage.module.css'
import skillsStyles from './SkillsSection.module.css'
import styles from './TriageMappingsSection.module.css'

interface TestResult {
  skillId: string | null
  source: 'mapped' | 'generic' | 'none'
}

export function TriageMappingsSection() {
  const { toast } = useToast()
  const [mappings, setMappings] = useState<TriageMapping[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [loading, setLoading] = useState(true)
  // Surface the 15s cross-instance cache propagation hint for one
  // window after a write, mirroring the SkillsSection pattern.
  const [cacheHintUntil, setCacheHintUntil] = useState<number | null>(null)

  // Inline create form state
  const [creating, setCreating] = useState(false)
  const [createKey, setCreateKey] = useState('')
  const [createSkillId, setCreateSkillId] = useState('')
  const [createSubmitting, setCreateSubmitting] = useState(false)

  // Inline edit-in-place state — tracks which row is being edited
  // and the dropdown's working value before save.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSkillId, setEditSkillId] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  const [confirmDelete, setConfirmDelete] = useState<TriageMapping | null>(null)

  // Test mapping panel state
  const [testProduct, setTestProduct] = useState('')
  const [testAlertType, setTestAlertType] = useState('')
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const fetchMappings = useCallback(async () => {
    try {
      const res = await fetch('/api/triage-mappings')
      if (res.ok) {
        const data = await res.json()
        setMappings(data.mappings ?? [])
      } else if (res.status === 403) {
        toast({ intent: 'error', title: 'Admin role required to view triage mappings' })
      } else {
        toast({ intent: 'error', title: 'Failed to load triage mappings' })
      }
    } catch {
      toast({ intent: 'error', title: 'Network error loading triage mappings' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills')
      if (res.ok) {
        const data = await res.json()
        setSkills(data.skills ?? [])
      }
    } catch {
      // Non-fatal — the dropdown will be empty and the inline form
      // will surface the validation error from the server. The
      // mapping table itself can still render and report skill IDs.
    }
  }, [])

  useEffect(() => {
    void fetchMappings()
    void fetchSkills()
  }, [fetchMappings, fetchSkills])

  const onMutated = useCallback(() => {
    setCacheHintUntil(Date.now() + 15_000)
    void fetchMappings()
  }, [fetchMappings])

  // Auto-clear the cache hint after 15s so it doesn't linger.
  useEffect(() => {
    if (!cacheHintUntil) return
    const remaining = cacheHintUntil - Date.now()
    if (remaining <= 0) {
      setCacheHintUntil(null)
      return
    }
    const t = setTimeout(() => setCacheHintUntil(null), remaining)
    return () => clearTimeout(t)
  }, [cacheHintUntil])

  const showCacheHint = cacheHintUntil !== null && cacheHintUntil > Date.now()

  const skillById = (id: string) => skills.find((s) => s.id === id)

  // ── Create handlers ─────────────────────────────────────────

  const startCreate = () => {
    setCreating(true)
    setCreateKey('')
    setCreateSkillId(skills[0]?.id ?? '')
  }

  const cancelCreate = () => {
    setCreating(false)
    setCreateKey('')
    setCreateSkillId('')
  }

  const handleCreate = async () => {
    if (!createKey.trim() || !createSkillId) {
      toast({
        intent: 'error',
        title: 'Both source key and skill are required.',
      })
      return
    }
    setCreateSubmitting(true)
    try {
      const res = await fetch('/api/triage-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: createKey.trim(), skillId: createSkillId }),
      })
      if (res.ok) {
        toast({ intent: 'success', title: 'Mapping created' })
        cancelCreate()
        onMutated()
        return
      }
      const data = await res.json().catch(() => ({}))
      toast({
        intent: 'error',
        title: 'Failed to create mapping',
        description: typeof data.error === 'string' ? data.error : undefined,
      })
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    } finally {
      setCreateSubmitting(false)
    }
  }

  // ── Edit handlers ───────────────────────────────────────────

  const startEdit = (mapping: TriageMapping) => {
    setEditingId(mapping.id)
    setEditSkillId(mapping.skillId)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditSkillId('')
  }

  const handleEditSave = async (mapping: TriageMapping) => {
    if (!editSkillId || editSkillId === mapping.skillId) {
      cancelEdit()
      return
    }
    setEditSubmitting(true)
    try {
      const res = await fetch(`/api/triage-mappings/${encodeURIComponent(mapping.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: editSkillId }),
      })
      if (res.ok) {
        toast({ intent: 'success', title: 'Mapping updated' })
        cancelEdit()
        onMutated()
        return
      }
      const data = await res.json().catch(() => ({}))
      toast({
        intent: 'error',
        title: 'Failed to update mapping',
        description: typeof data.error === 'string' ? data.error : undefined,
      })
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    } finally {
      setEditSubmitting(false)
    }
  }

  // ── Test mapping handlers ───────────────────────────────────

  const handleRunTest = async () => {
    if (!testProduct.trim() || !testAlertType.trim()) {
      toast({
        intent: 'error',
        title: 'Both product and alert type are required.',
      })
      return
    }
    setTestRunning(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/triage-mappings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: testProduct.trim(),
          alertType: testAlertType.trim(),
        }),
      })
      if (res.ok) {
        const data = (await res.json()) as TestResult
        setTestResult(data)
        return
      }
      const data = await res.json().catch(() => ({}))
      toast({
        intent: 'error',
        title: 'Failed to test mapping',
        description: typeof data.error === 'string' ? data.error : undefined,
      })
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    } finally {
      setTestRunning(false)
    }
  }

  const modal = confirmDelete ? (
    <MappingDeleteConfirmModal
      mapping={confirmDelete}
      onCancel={() => setConfirmDelete(null)}
      onDeleted={() => {
        toast({ intent: 'success', title: 'Mapping deleted' })
        setConfirmDelete(null)
        onMutated()
      }}
    />
  ) : null

  return (
    <section className={sharedStyles.section}>
      <h2 className={sharedStyles.sectionTitle}>Triage Mappings</h2>

      {showCacheHint && (
        <div className={skillsStyles.cacheHint} role="status" aria-live="polite">
          Changes propagating across instances; may take up to 15 seconds.
        </div>
      )}

      <div className={skillsStyles.toolbar}>
        <p className={sharedStyles.keyFieldHintText}>
          Bind alert source keys (<code>{'<product>:<alertType>'}</code>) to triage skills.
          Unmapped alerts fall through to the generic catch-all skill. Source keys are
          case-sensitive and must match the wire format the triage source emits.
        </p>
        <button
          type="button"
          className={skillsStyles.newButton}
          onClick={startCreate}
          disabled={creating}
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New
        </button>
      </div>

      {creating && (
        <div className={styles.inlineForm}>
          <div className={styles.inlineFormField}>
            <label htmlFor="new-mapping-key" className={sharedStyles.fieldLabel}>
              Source key
            </label>
            <input
              id="new-mapping-key"
              type="text"
              className={skillsStyles.idInput}
              value={createKey}
              onChange={(e) => setCreateKey(e.target.value)}
              placeholder="DefenderXDR:DefenderEndpoint.SuspiciousProcess"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={styles.inlineFormField}>
            <label htmlFor="new-mapping-skill" className={sharedStyles.fieldLabel}>
              Skill
            </label>
            <select
              id="new-mapping-skill"
              className={styles.editSelect}
              value={createSkillId}
              onChange={(e) => setCreateSkillId(e.target.value)}
            >
              {skills.length === 0 ? (
                <option value="">No skills available</option>
              ) : (
                skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id} ({s.id})
                  </option>
                ))
              )}
            </select>
          </div>
          <div className={styles.inlineFormActions}>
            <button
              type="button"
              className={skillsStyles.cancelButton}
              onClick={cancelCreate}
              disabled={createSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className={sharedStyles.saveButton}
              onClick={handleCreate}
              disabled={createSubmitting || !createKey.trim() || !createSkillId}
            >
              {createSubmitting ? 'Creating…' : 'Create mapping'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className={sharedStyles.keyStatusText}>Loading mappings…</p>
      ) : mappings.length === 0 ? (
        <p className={skillsStyles.empty}>
          No triage mappings yet. Click <strong>New</strong> to add one.
        </p>
      ) : (
        <div className={skillsStyles.tableWrapper}>
          <table className={skillsStyles.table}>
            <thead>
              <tr>
                <th className={skillsStyles.tableHeader}>Source key</th>
                <th className={skillsStyles.tableHeader}>Skill</th>
                <th className={skillsStyles.tableHeader}>Last updated</th>
                <th className={skillsStyles.tableHeader}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => {
                const isEditing = editingId === m.id
                const skill = skillById(m.skillId)
                return (
                  <tr key={m.id} className={skillsStyles.tableRow}>
                    <td className={`${skillsStyles.tableCell} ${skillsStyles.tableCellId}`}>
                      {m.id}
                    </td>
                    <td className={skillsStyles.tableCell}>
                      {isEditing ? (
                        <div className={styles.editCell}>
                          <select
                            className={styles.editSelect}
                            value={editSkillId}
                            onChange={(e) => setEditSkillId(e.target.value)}
                            aria-label="Select skill"
                          >
                            {skills.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name || s.id} ({s.id})
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className={styles.editSaveButton}
                            onClick={() => handleEditSave(m)}
                            disabled={editSubmitting}
                          >
                            {editSubmitting ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className={`${skillsStyles.actionButton} ${skillsStyles.actionView}`}
                            onClick={cancelEdit}
                            disabled={editSubmitting}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <strong>{skill?.name ?? m.skillId}</strong>
                          {skill && skill.id !== skill.name && (
                            <>
                              {' '}
                              <span className={sharedStyles.keyFieldHintText}>({m.skillId})</span>
                            </>
                          )}
                        </>
                      )}
                    </td>
                    <td className={skillsStyles.tableCell}>
                      <time dateTime={m.updatedAt}>
                        {m.updatedAt === '1970-01-01T00:00:00.000Z'
                          ? '—'
                          : new Date(m.updatedAt).toLocaleString()}
                      </time>
                    </td>
                    <td className={`${skillsStyles.tableCell} ${skillsStyles.tableCellActions}`}>
                      {!isEditing && (
                        <>
                          <button
                            type="button"
                            className={`${skillsStyles.actionButton} ${skillsStyles.actionEdit}`}
                            onClick={() => startEdit(m)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={`${skillsStyles.actionButton} ${skillsStyles.actionDelete}`}
                            onClick={() => setConfirmDelete(m)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.testPanel}>
        <h3 className={styles.testHeading}>Test mapping</h3>
        <p className={styles.testHelp}>
          Resolves a sample <code>{'<product>:<alertType>'}</code> against the live mapping
          table without running a real triage request. Shows whether the key would hit a
          configured mapping, the generic fallback, or no skill at all.
        </p>
        <div className={styles.testInputs}>
          <div className={styles.inlineFormField}>
            <label htmlFor="test-product" className={sharedStyles.fieldLabel}>
              Product
            </label>
            <input
              id="test-product"
              type="text"
              className={skillsStyles.idInput}
              value={testProduct}
              onChange={(e) => setTestProduct(e.target.value)}
              placeholder="DefenderXDR"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={styles.inlineFormField}>
            <label htmlFor="test-alert-type" className={sharedStyles.fieldLabel}>
              Alert type
            </label>
            <input
              id="test-alert-type"
              type="text"
              className={skillsStyles.idInput}
              value={testAlertType}
              onChange={(e) => setTestAlertType(e.target.value)}
              placeholder="DefenderEndpoint.SuspiciousProcess"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={styles.inlineFormActions}>
            <button
              type="button"
              className={sharedStyles.saveButton}
              onClick={handleRunTest}
              disabled={testRunning || !testProduct.trim() || !testAlertType.trim()}
            >
              {testRunning ? 'Resolving…' : 'Resolve'}
            </button>
          </div>
        </div>
        {testResult && (
          <div className={styles.testResult} role="status" aria-live="polite">
            <span>Resolves to:</span>
            <span className={styles.testResultSkillId}>
              {testResult.skillId ?? '(no skill registered)'}
            </span>
            <span
              className={
                testResult.source === 'mapped'
                  ? styles.testResultTagMapped
                  : testResult.source === 'generic'
                    ? styles.testResultTagGeneric
                    : styles.testResultTagNone
              }
            >
              {testResult.source === 'mapped'
                ? 'mapped'
                : testResult.source === 'generic'
                  ? 'generic fallback'
                  : 'none'}
            </span>
          </div>
        )}
      </div>

      {modal}
    </section>
  )
}
