'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Shield, ShieldAlert, Users, Info, Check, X } from 'lucide-react'
import type { IntegrationInfo } from '@/lib/types'
import styles from './IntegrationDetailPage.module.css'

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Shield,
  ShieldAlert,
  Users,
}

export interface IntegrationDetailPageProps {
  integration: IntegrationInfo
  secretStatuses: Record<string, boolean>
  className?: string
}

type FeedbackState = { type: 'idle' } | { type: 'success'; message: string } | { type: 'error'; message: string }

export function IntegrationDetailPage({
  integration,
  secretStatuses,
  className,
}: IntegrationDetailPageProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>({ type: 'idle' })
  const [testResult, setTestResult] = useState<FeedbackState>({ type: 'idle' })

  const Icon = ICONS[integration.iconName]

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    setFeedback({ type: 'idle' })

    try {
      const res = await fetch(`/api/integrations/${integration.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secrets: values }),
      })

      const data = await res.json()

      if (!res.ok) {
        setFeedback({ type: 'error', message: data.error ?? 'Failed to save' })
      } else {
        setFeedback({ type: 'success', message: `Updated ${data.updated?.length ?? 0} secret(s).` })
        setValues({})
      }
    } catch {
      setFeedback({ type: 'error', message: 'Network error. Check your connection.' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult({ type: 'idle' })

    try {
      const res = await fetch(`/api/integrations/${integration.slug}/test`, {
        method: 'POST',
      })

      const data = await res.json()

      if (data.success) {
        setTestResult({ type: 'success', message: 'Connection successful.' })
      } else {
        setTestResult({ type: 'error', message: data.error ?? 'Connection failed.' })
      }
    } catch {
      setTestResult({ type: 'error', message: 'Network error.' })
    } finally {
      setTesting(false)
    }
  }

  const hasChanges = Object.values(values).some((v) => v.trim() !== '')

  return (
    <div className={`${styles.container}${className ? ` ${className}` : ''}`}>
      <Link href="/integrations" className={styles.backLink}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to Integrations
      </Link>

      <div className={styles.header}>
        {Icon && (
          <div className={styles.iconWrapper} aria-hidden="true">
            <Icon size={32} />
          </div>
        )}
        <div>
          <h1 className={styles.heading}>{integration.name}</h1>
          <p className={styles.description}>{integration.description}</p>
        </div>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Capabilities</h2>
        <ul className={styles.capabilityList}>
          {integration.capabilities.map((tool) => (
            <li key={tool} className={styles.capabilityItem}>
              <code className={styles.toolName}>{tool}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 id="config-heading" className={styles.sectionTitle}>Configuration</h2>
        <p className={styles.requiredNote}>
          <span aria-hidden="true">*</span> Required field
        </p>

        <fieldset className={styles.form}>
          <legend className={styles.srOnly}>Integration credentials</legend>
          {integration.secrets.map((secret) => (
            <div key={secret.key} className={styles.fieldGroup}>
              <div className={styles.labelRow}>
                <label className={styles.fieldLabel} htmlFor={`secret-${secret.key}`}>
                  {secret.label}
                  {secret.required && <span className={styles.required} aria-hidden="true">*</span>}
                </label>
                <button
                  type="button"
                  className={styles.tooltipTrigger}
                  aria-label={`Help for ${secret.label}`}
                >
                  <Info size={14} aria-hidden="true" />
                  <span
                    id={`tooltip-${secret.key}`}
                    role="tooltip"
                    className={styles.tooltipText}
                  >
                    {secret.description}
                  </span>
                </button>
              </div>
              <input
                id={`secret-${secret.key}`}
                type="password"
                value={values[secret.key] ?? ''}
                onChange={(e) => handleChange(secret.key, e.target.value)}
                placeholder={secretStatuses[secret.key] ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (configured)' : 'Not configured'}
                className={styles.fieldInput}
                required={secret.required}
                aria-required={secret.required ? 'true' : undefined}
                aria-describedby={`tooltip-${secret.key}`}
              />
            </div>
          ))}
        </fieldset>

        <div role="status" aria-live="polite" aria-atomic="true">
          {feedback.type !== 'idle' && (
            <div className={feedback.type === 'success' ? styles.feedbackSuccess : styles.feedbackError}>
              {feedback.type === 'success' ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
              {feedback.message}
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className={styles.saveButton}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className={styles.testButton}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
        </div>

        <div role="status" aria-live="polite" aria-atomic="true">
          {testResult.type !== 'idle' && (
            <div className={testResult.type === 'success' ? styles.feedbackSuccess : styles.feedbackError}>
              {testResult.type === 'success' ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
              {testResult.message}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
