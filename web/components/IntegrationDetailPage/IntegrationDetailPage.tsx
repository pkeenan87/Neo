'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, Shield, ShieldAlert, Users, Info } from 'lucide-react'
import type { IntegrationInfo } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
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

export function IntegrationDetailPage({
  integration,
  secretStatuses,
  className,
}: IntegrationDetailPageProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const { toast } = useToast()

  const Icon = ICONS[integration.iconName]

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)

    try {
      const res = await fetch(`/api/integrations/${integration.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secrets: values }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast({ intent: 'error', title: 'Failed to save', description: data.error })
      } else {
        toast({
          intent: 'success',
          title: 'Integration saved',
          description: `Updated ${data.updated?.length ?? 0} secret(s).`,
        })
        setValues({})
      }
    } catch {
      toast({ intent: 'error', title: 'Network error', description: 'Check your connection.' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)

    try {
      const res = await fetch(`/api/integrations/${integration.slug}/test`, {
        method: 'POST',
      })

      const data = await res.json()

      if (data.success) {
        toast({ intent: 'success', title: 'Connection successful' })
      } else {
        toast({
          intent: 'error',
          title: 'Connection failed',
          description: data.error,
        })
      }
    } catch {
      toast({ intent: 'error', title: 'Network error' })
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
        <div className={styles.iconWrapper} aria-hidden="true">
          {integration.imageSrc ? (
            <Image src={integration.imageSrc} alt="" width={32} height={32} />
          ) : Icon ? (
            <Icon size={32} />
          ) : null}
        </div>
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
      </section>
    </div>
  )
}
