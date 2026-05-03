'use client'

import { useEffect, useRef, useState } from 'react'
import type { SkillMeta } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
import styles from './SkillsSection.module.css'

interface Props {
  skill: SkillMeta
  onCancel: () => void
  onDeleted: () => void
}

export function SkillDeleteConfirmModal({ skill, onCancel, onDeleted }: Props) {
  const { toast } = useToast()
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, submitting])

  const canConfirm = typed === skill.id && !submitting

  const handleDelete = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/skills/${skill.id}`, { method: 'DELETE' })
      if (res.ok) {
        onDeleted()
        return
      }
      const data = await res.json().catch(() => ({}))
      toast({
        intent: 'error',
        title: 'Failed to delete skill',
        description: typeof data.error === 'string' ? data.error : undefined,
      })
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel()
      }}
    >
      <div className={styles.modalContent}>
        <h3 id="skill-delete-title" className={styles.modalTitle}>
          Delete skill
        </h3>
        <p className={styles.modalBody}>
          This permanently removes the skill <span className={styles.modalCode}>{skill.id}</span>.
          The agent loop will lose access to it within 15 seconds across all instances.
        </p>
        <p className={styles.modalBody}>
          Type <span className={styles.modalCode}>{skill.id}</span> to confirm.
        </p>
        <input
          ref={inputRef}
          type="text"
          className={styles.idInput}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={`Type ${skill.id} to confirm deletion`}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.modalConfirm}
            onClick={handleDelete}
            disabled={!canConfirm}
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
