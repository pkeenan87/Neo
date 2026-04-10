'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { ProgressBar } from './ProgressBar'
import styles from './SettingsPage.module.css'

interface UsageSummary {
  totalInputTokens: number
}

interface UsageResponse {
  enforced: boolean
  twoHourUsage: UsageSummary
  weeklyUsage: UsageSummary
  twoHourLimit: number
  weeklyLimit: number
  projectedMonthlyCostUsd: number
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'less than a minute ago'
  const minutes = Math.floor(seconds / 60)
  return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
}

export interface UsageSectionProps {
  className?: string
}

export function UsageSection({ className }: UsageSectionProps) {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchUsage = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/usage', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch usage data')
      const json: UsageResponse = await res.json()
      setData(json)
      setLastUpdated(new Date())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load usage data'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchUsage()
  }, [fetchUsage])

  if (error) {
    return (
      <div className={`${styles.section}${className ? ` ${className}` : ''}`}>
        <h2 className={styles.sectionTitle}>Plan usage limits</h2>
        <p className={styles.errorText}>{error}</p>
        <button type="button" onClick={fetchUsage} className={styles.retryButton}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className={`${styles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={styles.sectionTitle}>Plan usage limits</h2>

      {data && !data.enforced && (
        <p className={styles.disabledNotice} role="status">
          Usage limits are currently disabled. Consumption is still tracked for reporting.
        </p>
      )}

      <ProgressBar
        label="Current session"
        subtitle="Resets in ~2 hr"
        value={data?.twoHourUsage.totalInputTokens ?? 0}
        max={data?.twoHourLimit ?? 1}
        loading={loading}
      />

      <div className={styles.divider} />

      <h3 className={styles.subsectionTitle}>Weekly limits</h3>

      <ProgressBar
        label="All models"
        subtitle="Resets in ~7 days"
        value={data?.weeklyUsage.totalInputTokens ?? 0}
        max={data?.weeklyLimit ?? 1}
        loading={loading}
      />

      {data && (
        <p className={styles.costEstimate}>
          Estimated monthly cost: ${data.projectedMonthlyCostUsd.toFixed(2)}
        </p>
      )}

      <div className={styles.lastUpdated}>
        <span aria-live="polite" aria-atomic="true">
          {loading
            ? 'Refreshing usage data...'
            : `Last updated: ${lastUpdated ? formatTimeAgo(lastUpdated) : 'never'}`}
        </span>
        <button
          type="button"
          onClick={fetchUsage}
          className={styles.refreshButton}
          aria-label="Refresh usage data"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4${loading ? ` ${styles.spinning}` : ''}`} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
