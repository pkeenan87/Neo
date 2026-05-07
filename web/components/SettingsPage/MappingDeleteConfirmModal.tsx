'use client'

import { useEffect, useRef, useState } from 'react'
import type { TriageMapping } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
import styles from './SkillsSection.module.css'

interface Props {
  mapping: TriageMapping
  onCancel: () => void
  onDeleted: () => void
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function MappingDeleteConfirmModal({ mapping, onCancel, onDeleted }: Props) {
  const { toast } = useToast()
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ESC dismiss + Tab/Shift-Tab focus trap. Same pattern as
  // SkillDeleteConfirmModal so admins get one consistent interaction
  // for destructive admin actions.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onCancel()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, submitting])

  const canConfirm = typed === mapping.id && !submitting

  const handleDelete = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/triage-mappings/${encodeURIComponent(mapping.id)}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        onDeleted()
        return
      }
      const data = await res.json().catch(() => ({}))
      toast({
        intent: 'error',
        title: 'Failed to delete mapping',
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
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className={styles.modalContent}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mapping-delete-title"
      >
        <h3 id="mapping-delete-title" className={styles.modalTitle}>
          Delete triage mapping
        </h3>
        <p className={styles.modalBody}>
          This removes the mapping <span className={styles.modalCode}>{mapping.id}</span>.
          Alerts of this type will fall through to the generic triage skill within 15 seconds
          across all instances.
        </p>
        <p className={styles.modalBody}>
          Type <span className={styles.modalCode}>{mapping.id}</span> to confirm.
        </p>
        <input
          ref={inputRef}
          type="text"
          className={styles.idInput}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={`Type ${mapping.id} to confirm deletion`}
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
