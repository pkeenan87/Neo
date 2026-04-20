'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import type { ApiKeyRecordPublic } from '@/lib/api-key-store'
import { useToast } from '@/context/ToastContext'
import styles from './SettingsPage.module.css'

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function getKeyStatus(record: ApiKeyRecordPublic): 'active' | 'expired' | 'revoked' {
  if (record.revoked) return 'revoked'
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyRecordPublic[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  // Create form state
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<'admin' | 'reader'>('reader')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)

  // Inline revoke confirmation
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null)

  // One-time key display modal
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const modalFirstFocusRef = useRef<HTMLButtonElement>(null)

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/api-keys')
      if (res.ok) {
        const data = await res.json()
        setKeys(data.keys ?? [])
      }
    } catch {
      // Silent — keys table will be empty
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchKeys() }, [fetchKeys])

  // Modal focus management
  useEffect(() => {
    if (newKey) {
      modalFirstFocusRef.current?.focus()
    }
  }, [newKey])

  // Escape to dismiss modal
  useEffect(() => {
    if (!newKey) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissModal()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [newKey])

  const handleCreate = async () => {
    setCreating(true)

    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          role,
          expiresAt: expiresAt || undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast({ intent: 'error', title: 'Failed to create key', description: data.error })
      } else {
        setNewKey(data.rawKey)
        setLabel('')
        setExpiresAt('')
        void fetchKeys()
      }
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    setConfirmingRevoke(null)

    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ intent: 'success', title: 'Key revoked' })
        void fetchKeys()
      } else {
        const data = await res.json()
        toast({ intent: 'error', title: 'Failed to revoke key', description: data.error })
      }
    } catch {
      toast({ intent: 'error', title: 'Network error' })
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    await navigator.clipboard.writeText(newKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const dismissModal = useCallback(() => {
    setNewKey(null)
    setCopied(false)
    setTimeout(() => createButtonRef.current?.focus(), 0)
  }, [])

  const maxDate = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>API Keys</h2>

      {/* Create form */}
      <form
        className={styles.keyCreateForm}
        onSubmit={(e) => { e.preventDefault(); void handleCreate() }}
        aria-label="Create API key"
      >
        <div className={styles.profileFieldWide}>
          <label className={styles.fieldLabel} htmlFor="key-label">Label</label>
          <input
            id="key-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. CI Pipeline"
            maxLength={128}
            className={styles.fieldInput}
          />
        </div>
        <div className={styles.profileFieldWide}>
          <label className={styles.fieldLabel} htmlFor="key-role">Role</label>
          <select
            id="key-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'reader')}
            className={styles.fieldInput}
          >
            <option value="reader">Reader</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className={styles.profileFieldWide}>
          <label className={styles.fieldLabel} htmlFor="key-expires">
            Expires <span className={styles.keyFieldHint}>(optional)</span>
          </label>
          <input
            id="key-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
            max={maxDate}
            aria-describedby="key-expires-hint"
            className={styles.fieldInput}
          />
          <span id="key-expires-hint" className={styles.keyFieldHintText}>
            Leave blank for non-expiring. Max 2 years.
          </span>
        </div>
        <button
          ref={createButtonRef}
          type="submit"
          disabled={creating || !label.trim()}
          className={styles.saveButton}
        >
          {creating ? 'Creating...' : 'Create Key'}
        </button>
      </form>

      {/* In-flight hint for the create action (success/error go to toasts) */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {creating && <span className={styles.keyFieldHintText}>Creating key, please wait...</span>}
      </div>

      {/* Keys table */}
      {loading ? (
        <p className={styles.keyStatusText} aria-live="polite">Loading API keys...</p>
      ) : keys.length === 0 ? (
        <p className={styles.keyStatusText}>No API keys configured.</p>
      ) : (
        <div className={styles.keyTableWrapper}>
          <table className={styles.keyTable} aria-label="API keys">
            <thead>
              <tr>
                <th className={styles.keyTableHeader}>Label</th>
                <th className={styles.keyTableHeader}>Role</th>
                <th className={styles.keyTableHeader}>Created</th>
                <th className={styles.keyTableHeader}>Expires</th>
                <th className={styles.keyTableHeader}>Last Used</th>
                <th className={styles.keyTableHeader}>Status</th>
                <th className={styles.keyTableHeader}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const status = getKeyStatus(k)
                return (
                  <tr key={k.id} className={styles.keyTableRow}>
                    <td className={styles.keyTableCell}>{k.label}</td>
                    <td className={styles.keyTableCell}>{k.role}</td>
                    <td className={styles.keyTableCell}>{formatDate(k.createdAt)}</td>
                    <td className={styles.keyTableCell}>{formatDate(k.expiresAt)}</td>
                    <td className={styles.keyTableCell}>{formatDate(k.lastUsedAt)}</td>
                    <td className={styles.keyTableCell}>
                      <span className={`${styles.keyBadge} ${styles[`keyBadge_${status}`]}`}>
                        {STATUS_LABELS[status]}
                      </span>
                    </td>
                    <td className={styles.keyTableCell}>
                      {status === 'active' && (
                        confirmingRevoke === k.id ? (
                          <span className={styles.keyRevokeConfirm}>
                            Revoke &ldquo;{k.label}&rdquo;?{' '}
                            <button
                              type="button"
                              onClick={() => handleRevoke(k.id)}
                              className={styles.keyRevokeButton}
                            >
                              Yes
                            </button>
                            {' '}
                            <button
                              type="button"
                              onClick={() => setConfirmingRevoke(null)}
                              className={styles.keyCancelButton}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingRevoke(k.id)}
                            className={styles.keyRevokeButton}
                            aria-label={`Revoke API key: ${k.label}`}
                          >
                            Revoke
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* One-time key display modal */}
      {newKey && (
        <div className={styles.keyModalOverlay} onClick={dismissModal}>
          <div
            className={styles.keyModalContent}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="New API key"
            aria-modal="true"
          >
            <h3 className={styles.subsectionTitle}>API Key Created</h3>
            <p className={styles.keyModalWarning}>
              This key will only be shown once. Copy it now.
            </p>
            <div className={styles.keyDisplay}>
              <code className={styles.keyDisplayCode}>{newKey}</code>
              <button
                ref={modalFirstFocusRef}
                type="button"
                onClick={handleCopy}
                className={styles.keyCopyButton}
                aria-label={copied ? 'Copied' : 'Copy to clipboard'}
              >
                {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              </button>
            </div>
            <button
              type="button"
              onClick={dismissModal}
              className={styles.saveButton}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
