'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Shield, ShieldAlert, Users, Search, ArrowLeft } from 'lucide-react'
import type { IntegrationInfo } from '@/lib/types'
import styles from './IntegrationsPage.module.css'

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Shield,
  ShieldAlert,
  Users,
}

type ConfigStatus = 'configured' | 'partial' | 'none'

export interface IntegrationsPageProps {
  integrations: IntegrationInfo[]
  secretStatuses: Record<string, boolean>
  className?: string
}

function getConfigStatus(
  integration: IntegrationInfo,
  statuses: Record<string, boolean>
): ConfigStatus {
  const keys = integration.secrets.map((s) => s.key)
  const configured = keys.filter((k) => statuses[k])
  if (configured.length === keys.length) return 'configured'
  if (configured.length > 0) return 'partial'
  return 'none'
}

const STATUS_LABELS: Record<ConfigStatus, string> = {
  configured: 'Configured',
  partial: 'Partially Configured',
  none: 'Not Configured',
}

export function IntegrationsPage({
  integrations,
  secretStatuses,
  className,
}: IntegrationsPageProps) {
  const [search, setSearch] = useState('')

  const filtered = integrations.filter((i) => {
    const q = search.toLowerCase()
    return i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
  })

  return (
    <div className={`${styles.container}${className ? ` ${className}` : ''}`}>
      <Link href="/chat" className={styles.backLink}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to chat
      </Link>

      <div className={styles.header}>
        <h1 className={styles.heading}>Integrations</h1>
        <p className={styles.subtitle}>
          Configure credentials for security tool integrations.
        </p>
      </div>

      <div className={styles.searchWrapper}>
        <Search size={16} aria-hidden="true" />
        <label htmlFor="integration-search" className={styles.srOnly}>
          Search integrations
        </label>
        <input
          id="integration-search"
          type="search"
          placeholder="Search integrations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.searchInput}
        />
      </div>

      <div className={styles.grid}>
        {filtered.map((integration) => {
          const Icon = ICONS[integration.iconName]
          const status = getConfigStatus(integration, secretStatuses)

          return (
            <Link
              key={integration.slug}
              href={`/integrations/${integration.slug}`}
              className={styles.card}
            >
              <div className={styles.cardHeader}>
                <div className={styles.iconWrapper} aria-hidden="true">
                  {integration.imageSrc ? (
                    <Image src={integration.imageSrc} alt="" width={24} height={24} />
                  ) : Icon ? (
                    <Icon size={24} />
                  ) : null}
                </div>
                <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
                  {STATUS_LABELS[status]}
                </span>
              </div>
              <h2 className={styles.cardTitle}>{integration.name}</h2>
              <p className={styles.cardDescription}>{integration.description}</p>
              <p className={styles.cardCapabilities}>
                {integration.capabilities.length} tool{integration.capabilities.length !== 1 ? 's' : ''}
              </p>
            </Link>
          )
        })}
      </div>

      <p role="status" aria-live="polite" className={styles.emptyState}>
        {filtered.length === 0 ? 'No integrations match your search.' : ''}
      </p>
    </div>
  )
}
