'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { ProgressBar } from './ProgressBar'
import styles from './AdminUsageSection.module.css'
import sharedStyles from './SettingsPage.module.css'

interface UsageSummary {
  totalInputTokens: number
  estimatedCostUsd: number
}

interface UserUsageRow {
  userIdHash: string
  twoHourUsage: UsageSummary
  weeklyUsage: UsageSummary
}

interface AdminUsageResponse {
  users: UserUsageRow[]
  page: number
  totalPages: number
  limits: {
    twoHourMax: number
    weeklyMax: number
  }
}

type ConfirmTarget = {
  userIdHash: string
  windowType: 'two-hour' | 'weekly'
} | null

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export interface AdminUsageSectionProps {
  className?: string
}

export function AdminUsageSection({ className }: AdminUsageSectionProps) {
  const [data, setData] = useState<AdminUsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null)
  const [resetting, setResetting] = useState(false)
  const confirmYesRef = useRef<HTMLButtonElement>(null)

  // Move focus to "Yes" button when confirmation appears
  useEffect(() => {
    if (confirmTarget) {
      confirmYesRef.current?.focus()
    }
  }, [confirmTarget])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/usage', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch usage data')
      const json: AdminUsageResponse = await res.json()
      setData(json)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load usage data'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleReset = async () => {
    if (!confirmTarget) return
    setResetting(true)
    setResetError(null)
    try {
      const res = await fetch('/api/admin/usage/reset', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: confirmTarget.userIdHash,
          window: confirmTarget.windowType,
        }),
      })
      if (!res.ok) throw new Error('Reset failed')
      setConfirmTarget(null)
      await fetchData()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reset failed'
      setResetError(message)
      setConfirmTarget(null)
    } finally {
      setResetting(false)
    }
  }

  if (error) {
    return (
      <div className={`${sharedStyles.section}${className ? ` ${className}` : ''}`}>
        <h2 className={sharedStyles.sectionTitle}>Usage Limits (Admin)</h2>
        <p className={sharedStyles.errorText} role="alert">{error}</p>
        <button type="button" onClick={fetchData} className={sharedStyles.retryButton}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className={`${sharedStyles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={sharedStyles.sectionTitle}>Usage Limits (Admin)</h2>

      <p className={`${sharedStyles.lastUpdated} ${styles.limitsRow}`}>
        <span aria-live="polite" aria-atomic="true">
          {loading
            ? 'Loading usage data...'
            : data
            ? `Configured limits: ${formatTokens(data.limits.twoHourMax)} / 2 hr, ${formatTokens(data.limits.weeklyMax)} / week`
            : ''}
        </span>
        <button
          type="button"
          onClick={fetchData}
          className={sharedStyles.refreshButton}
          aria-label="Refresh usage data"
          aria-busy={loading}
          disabled={loading}
        >
          <RefreshCw
            className={`w-4 h-4${loading ? ` ${sharedStyles.spinning}` : ''}`}
            aria-hidden="true"
          />
        </button>
      </p>

      {resetError && (
        <p className={sharedStyles.errorText} role="alert">{resetError}</p>
      )}

      {data && data.users.length === 0 && (
        <p className={styles.emptyText}>No usage recorded in the current windows.</p>
      )}

      {data?.users.map((user) => {
        const isConfirming2h =
          confirmTarget?.userIdHash === user.userIdHash && confirmTarget?.windowType === 'two-hour'
        const isConfirmingWeekly =
          confirmTarget?.userIdHash === user.userIdHash && confirmTarget?.windowType === 'weekly'

        return (
          <section
            key={user.userIdHash}
            className={styles.userCard}
            aria-labelledby={`user-heading-${user.userIdHash}`}
          >
            <div className={styles.userHeader}>
              <h3
                id={`user-heading-${user.userIdHash}`}
                className={styles.userId}
              >
                <span className={styles.srOnly}>User: </span>
                {user.userIdHash}
              </h3>
              <div
                className={styles.resetGroup}
                role="group"
                aria-label={`Reset controls for ${user.userIdHash}`}
              >
                {isConfirming2h ? (
                  <span role="alert" className={styles.confirmOverlay}>
                    Reset 2-hr?{' '}
                    <button
                      ref={confirmYesRef}
                      type="button"
                      className={styles.confirmYes}
                      aria-label={`Confirm reset 2-hour window for ${user.userIdHash}`}
                      onClick={handleReset}
                      disabled={resetting}
                    >
                      Yes
                    </button>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      className={styles.confirmCancel}
                      aria-label={`Cancel reset for ${user.userIdHash}`}
                      onClick={() => setConfirmTarget(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.resetButton}
                    aria-label={`Reset 2-hour window for ${user.userIdHash}`}
                    onClick={() =>
                      setConfirmTarget({ userIdHash: user.userIdHash, windowType: 'two-hour' })
                    }
                  >
                    Reset 2-hr
                  </button>
                )}
                {isConfirmingWeekly ? (
                  <span role="alert" className={styles.confirmOverlay}>
                    Reset weekly?{' '}
                    <button
                      ref={isConfirming2h ? undefined : confirmYesRef}
                      type="button"
                      className={styles.confirmYes}
                      aria-label={`Confirm reset weekly window for ${user.userIdHash}`}
                      onClick={handleReset}
                      disabled={resetting}
                    >
                      Yes
                    </button>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      className={styles.confirmCancel}
                      aria-label={`Cancel reset for ${user.userIdHash}`}
                      onClick={() => setConfirmTarget(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.resetButton}
                    aria-label={`Reset weekly window for ${user.userIdHash}`}
                    onClick={() =>
                      setConfirmTarget({ userIdHash: user.userIdHash, windowType: 'weekly' })
                    }
                  >
                    Reset weekly
                  </button>
                )}
              </div>
            </div>

            <ProgressBar
              label="2-hour window"
              subtitle={`${formatTokens(user.twoHourUsage.totalInputTokens)} / ${formatTokens(data.limits.twoHourMax)}`}
              value={user.twoHourUsage.totalInputTokens}
              max={data.limits.twoHourMax}
              loading={loading}
            />

            <ProgressBar
              label="Weekly window"
              subtitle={`${formatTokens(user.weeklyUsage.totalInputTokens)} / ${formatTokens(data.limits.weeklyMax)}`}
              value={user.weeklyUsage.totalInputTokens}
              max={data.limits.weeklyMax}
              loading={loading}
            />
          </section>
        )
      })}
    </div>
  )
}
