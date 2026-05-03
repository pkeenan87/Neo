'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { SkillMeta } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
import { SkillEditor } from './SkillEditor'
import { SkillDetailView } from './SkillDetailView'
import { SkillDeleteConfirmModal } from './SkillDeleteConfirmModal'
import sharedStyles from './SettingsPage.module.css'
import styles from './SkillsSection.module.css'

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string }

export function SkillsSection() {
  const { toast } = useToast()
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [confirmDelete, setConfirmDelete] = useState<SkillMeta | null>(null)
  // Surface the 15s cross-instance cache propagation hint for one cycle
  // after a write. The list is local so refetch is instant; this hint is
  // only relevant when other App Service instances serve the next read.
  const [cacheHintUntil, setCacheHintUntil] = useState<number | null>(null)

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills')
      if (res.ok) {
        const data = await res.json()
        setSkills(data.skills ?? [])
      } else {
        toast({ intent: 'error', title: 'Failed to load skills' })
      }
    } catch {
      toast({ intent: 'error', title: 'Network error loading skills' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void fetchSkills()
  }, [fetchSkills])

  const onMutated = useCallback(() => {
    setCacheHintUntil(Date.now() + 15_000)
    void fetchSkills()
  }, [fetchSkills])

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

  // The modal is rendered as a sibling so it overlays regardless of
  // which view is currently active. position: fixed; inset: 0 in CSS.
  const modal = confirmDelete ? (
    <SkillDeleteConfirmModal
      skill={confirmDelete}
      onCancel={() => setConfirmDelete(null)}
      onDeleted={() => {
        toast({ intent: 'success', title: 'Skill deleted' })
        const wasViewingDeleted =
          (view.kind === 'detail' || view.kind === 'edit') && view.id === confirmDelete.id
        setConfirmDelete(null)
        if (wasViewingDeleted) {
          setView({ kind: 'list' })
        }
        onMutated()
      }}
    />
  ) : null

  if (view.kind === 'create') {
    return (
      <>
        <SkillEditor
          mode="create"
          onCancel={() => setView({ kind: 'list' })}
          onSaved={() => {
            toast({ intent: 'success', title: 'Skill created' })
            setView({ kind: 'list' })
            onMutated()
          }}
        />
        {modal}
      </>
    )
  }

  if (view.kind === 'edit') {
    return (
      <>
        <SkillEditor
          mode="edit"
          skillId={view.id}
          onCancel={() => setView({ kind: 'detail', id: view.id })}
          onSaved={() => {
            toast({ intent: 'success', title: 'Skill updated' })
            setView({ kind: 'detail', id: view.id })
            onMutated()
          }}
        />
        {modal}
      </>
    )
  }

  if (view.kind === 'detail') {
    return (
      <>
        <SkillDetailView
          skillId={view.id}
          onBack={() => setView({ kind: 'list' })}
          onEdit={() => setView({ kind: 'edit', id: view.id })}
          onDelete={(skill) => setConfirmDelete(skill)}
        />
        {modal}
      </>
    )
  }

  return (
    <section className={sharedStyles.section}>
      <h2 className={sharedStyles.sectionTitle}>Skills</h2>

      {showCacheHint && (
        <div className={styles.cacheHint} role="status" aria-live="polite">
          Changes propagating across instances; may take up to 15 seconds.
        </div>
      )}

      <div className={styles.toolbar}>
        <p className={sharedStyles.keyFieldHintText}>
          Admin-defined investigation skills. The agent loop can invoke these
          from a slash-command prefix in chat. Changes are live within 15
          seconds across all instances.
        </p>
        <button
          type="button"
          className={styles.newButton}
          onClick={() => setView({ kind: 'create' })}
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New skill
        </button>
      </div>

      {loading ? (
        <p className={sharedStyles.keyStatusText}>Loading skills…</p>
      ) : skills.length === 0 ? (
        <p className={styles.empty}>
          No skills yet. Click <strong>New skill</strong> to add one.
        </p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableHeader}>ID</th>
                <th className={styles.tableHeader}>Name</th>
                <th className={styles.tableHeader}>Description</th>
                <th className={styles.tableHeader}>Role</th>
                <th className={styles.tableHeader}>Tools</th>
                <th className={styles.tableHeader}>Params</th>
                <th className={styles.tableHeader}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id} className={styles.tableRow}>
                  <td className={`${styles.tableCell} ${styles.tableCellId}`}>{skill.id}</td>
                  <td className={styles.tableCell}>{skill.name || '—'}</td>
                  <td className={`${styles.tableCell} ${styles.tableCellDescription}`}>
                    {skill.description || '—'}
                  </td>
                  <td className={styles.tableCell}>
                    <span
                      className={`${styles.roleBadge} ${
                        skill.requiredRole === 'admin'
                          ? styles.roleBadgeAdmin
                          : styles.roleBadgeReader
                      }`}
                    >
                      {skill.requiredRole}
                    </span>
                  </td>
                  <td className={styles.tableCell}>{skill.requiredTools.length}</td>
                  <td className={styles.tableCell}>{skill.parameters.length}</td>
                  <td className={`${styles.tableCell} ${styles.tableCellActions}`}>
                    <button
                      type="button"
                      className={`${styles.actionButton} ${styles.actionView}`}
                      onClick={() => setView({ kind: 'detail', id: skill.id })}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionButton} ${styles.actionEdit}`}
                      onClick={() => setView({ kind: 'edit', id: skill.id })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionButton} ${styles.actionDelete}`}
                      onClick={() => setConfirmDelete(skill)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal}
    </section>
  )
}
