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
