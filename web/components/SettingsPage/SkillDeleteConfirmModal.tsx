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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function SkillDeleteConfirmModal({ skill, onCancel, onDeleted }: Props) {
  const { toast } = useToast()
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Populated when the server returns 409 — the skill is referenced
  // by one or more triage mappings. While set, the Delete button is
  // hard-blocked: the operator must remove or reassign the mappings
  // in the Triage Mappings tab before the skill can be deleted.
  const [blockingMappings, setBlockingMappings] = useState<string[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ESC dismiss + Tab/Shift-Tab focus trap. Cycles focus between the
  // first and last focusable element inside the dialog so a keyboard
  // user can't tab into the underlying page mid-confirmation.
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

  const canConfirm = typed === skill.id && !submitting && !blockingMappings

  const handleDelete = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/skills/${skill.id}`, { method: 'DELETE' })
      if (res.ok) {
        onDeleted()
        return
      }
      const data = await res.json().catch(() => ({}))
      // 409 with blockingMappings — the skill is referenced by
      // triage mappings. Show the list inline and lock the Delete
      // button until the operator removes the references.
      if (
        res.status === 409 &&
        Array.isArray(data.blockingMappings) &&
        data.blockingMappings.every((k: unknown) => typeof k === 'string')
      ) {
        setBlockingMappings(data.blockingMappings)
        return
      }
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
        aria-labelledby="skill-delete-title"
      >
        <h3 id="skill-delete-title" className={styles.modalTitle}>
          Delete skill
        </h3>
        {blockingMappings ? (
          <>
            <p className={styles.modalBody} role="alert">
              Cannot delete <span className={styles.modalCode}>{skill.id}</span> — it is
              referenced by {blockingMappings.length} triage mapping
              {blockingMappings.length === 1 ? '' : 's'}. Remove or reassign them in the
              Triage Mappings tab first, then try deleting the skill again.
            </p>
            <ul className={styles.modalBlockingList}>
              {blockingMappings.map((key) => (
                <li key={key} className={styles.modalCode}>{key}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className={styles.modalBody}>
              This permanently removes the skill <span className={styles.modalCode}>{skill.id}</span>.
              The agent loop will lose access to it within 15 seconds across all instances.
            </p>
            <p className={styles.modalBody}>
              Type <span className={styles.modalCode}>{skill.id}</span> to confirm.
            </p>
          </>
        )}
        {!blockingMappings && (
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
        )}
        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            disabled={submitting}
          >
            {blockingMappings ? 'Close' : 'Cancel'}
          </button>
          {!blockingMappings && (
            <button
              type="button"
              className={styles.modalConfirm}
              onClick={handleDelete}
              disabled={!canConfirm}
            >
              {submitting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
