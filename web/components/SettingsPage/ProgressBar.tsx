'use client'

import styles from './SettingsPage.module.css'

export interface ProgressBarProps {
  label: string
  subtitle: string
  value: number
  max: number
  loading?: boolean
  className?: string
}

export function ProgressBar({ label, subtitle, value, max, loading = false, className }: ProgressBarProps) {
  const percentage = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0

  let colorClass = styles.barFillNormal
  if (percentage >= 95) {
    colorClass = styles.barFillDanger
  } else if (percentage >= 80) {
    colorClass = styles.barFillWarning
  }

  return (
    <div className={`${styles.progressRow}${className ? ` ${className}` : ''}`}>
      <div className={styles.progressLabels}>
        <span className={styles.progressLabel}>{label}</span>
        <span className={styles.progressSubtitle}>{subtitle}</span>
      </div>
      <div
        className={styles.barTrack}
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${label}: ${percentage}% used`}
        aria-label={label}
        aria-busy={loading}
      >
        <div
          className={`${styles.barFill} ${colorClass}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className={styles.progressPercent}>{percentage}% used</span>
    </div>
  )
}
