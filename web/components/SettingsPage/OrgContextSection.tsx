'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Check, Upload } from 'lucide-react'
import { ORG_CONTEXT_MAX_CHARS, ORG_CONTEXT_WARN_CHARS } from '@/lib/org-context-constants'
import styles from './OrgContextSection.module.css'
import sharedStyles from './SettingsPage.module.css'

type Backend = 'blob' | 'keyvault'

interface OrgContextResponse {
  orgContext: string | null
  orgName: string
  backend: Backend
}

export interface OrgContextSectionProps {
  className?: string
}

const BACKEND_LABEL: Record<Backend, string> = {
  blob: 'Azure Blob Storage',
  keyvault: 'Azure Key Vault',
}

export function OrgContextSection({ className }: OrgContextSectionProps) {
  const [orgName, setOrgName] = useState<string>('')
  const [context, setContext] = useState('')
  const [savedContext, setSavedContext] = useState('')
  const [backend, setBackend] = useState<Backend>('keyvault')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/org-context', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch organizational context')
      const data: OrgContextResponse = await res.json()
      setOrgName(data.orgName)
      setContext(data.orgContext ?? '')
      setSavedContext(data.orgContext ?? '')
      setBackend(data.backend)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load data'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/admin/org-context', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgContext: context }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Save failed')
      }
      setSavedContext(context)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset the input so re-selecting the same file fires onChange again.
    event.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      setContext(text)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read file'
      setError(message)
    }
  }

  const isDirty = context !== savedContext
  const overLimit = context.length > ORG_CONTEXT_MAX_CHARS
  const charCountClass = overLimit
    ? styles.charCountError
    : context.length > ORG_CONTEXT_WARN_CHARS
    ? styles.charCountWarn
    : styles.charCount

  if (error && !loading) {
    return (
      <div className={`${sharedStyles.section}${className ? ` ${className}` : ''}`}>
        <h2 className={sharedStyles.sectionTitle}>Organization</h2>
        <p className={sharedStyles.errorText} role="alert">{error}</p>
        <button type="button" onClick={fetchData} className={sharedStyles.retryButton}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className={`${sharedStyles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={sharedStyles.sectionTitle}>Organization</h2>

      <dl className={styles.orgNameRow}>
        <dt className={sharedStyles.fieldLabel}>Organization Name</dt>
        <dd className={styles.orgNameValue}>{orgName || 'Not set'}</dd>
        <dd className={styles.orgNameHint}>
          Configured via the ORG_NAME environment variable. Requires a server restart to change.
        </dd>
      </dl>

      <div className={sharedStyles.divider} />

      <h3 className={sharedStyles.subsectionTitle}>Organizational Context</h3>
      <p className={styles.contextDescription}>
        Add context that helps Neo investigate more effectively — domain names, SAM account
        formats, VPN IP ranges, critical assets, escalation contacts, or a full environment
        fingerprint (YAML / Markdown / plain text). This is injected into the system prompt
        for every conversation.
      </p>

      <div className={styles.backendBadge} role="note" aria-live="polite">
        <span>Stored in</span>
        <span className={styles.backendBadgeLabel}>{BACKEND_LABEL[backend]}</span>
      </div>

      {saved && (
        <div className={styles.feedbackSuccess} role="status">
          <Check className={styles.feedbackIcon} aria-hidden="true" />
          Organizational context saved
        </div>
      )}

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.uploadButton}
          onClick={handleUploadClick}
          disabled={loading}
          aria-label="Upload a file to populate the organizational context"
        >
          <Upload className={styles.feedbackIcon} aria-hidden="true" />
          Upload file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,.md,.txt"
          className={styles.fileInputHidden}
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      <textarea
        id="org-context-textarea"
        className={styles.contextTextarea}
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder={`Example:\n- Primary domains: acme.com, acmecorp.onmicrosoft.com\n- SAM account format: first.last\n- VPN egress IPs: 203.0.113.0/24\n- Critical servers: DC01, EXCH01, FS01\n- Escalation: SOC lead — jsmith@acme.com`}
        aria-label="Organizational context"
        aria-describedby="org-context-count"
        aria-invalid={overLimit}
        disabled={loading}
        maxLength={ORG_CONTEXT_MAX_CHARS}
      />

      <div className={styles.contextFooter}>
        <span
          id="org-context-count"
          className={charCountClass}
          aria-live="polite"
          aria-atomic="true"
        >
          {context.length.toLocaleString()} / {ORG_CONTEXT_MAX_CHARS.toLocaleString()} characters
          {overLimit && ' — exceeds maximum'}
        </span>
        <button
          type="button"
          className={sharedStyles.saveButton}
          onClick={handleSave}
          disabled={saving || !isDirty || overLimit}
          aria-label={saving ? 'Saving, please wait' : undefined}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
