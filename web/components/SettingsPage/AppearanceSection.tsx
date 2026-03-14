'use client'

import { useTheme, type Theme } from '@/context/ThemeContext'
import styles from './SettingsPage.module.css'

export interface AppearanceSectionProps {
  className?: string
}

const MODES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
]

export function AppearanceSection({ className }: AppearanceSectionProps) {
  const { theme, setTheme } = useTheme()

  return (
    <div className={`${styles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={styles.sectionTitle}>Appearance</h2>
      <div role="group" aria-labelledby="color-mode-label">
        <span id="color-mode-label" className={styles.fieldLabel}>Color mode</span>
        <div className={styles.modeCards}>
          {MODES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={`${styles.modeCard} ${theme === value ? styles.modeCardActive : ''}`}
              aria-pressed={theme === value}
            >
              <div className={`${styles.modeThumbnail} ${styles[`modeThumbnail_${value}`]}`} aria-hidden="true">
                <div className={styles.thumbHeader} />
                <div className={styles.thumbSidebar} />
                <div className={styles.thumbContent}>
                  <div className={styles.thumbLine} />
                  <div className={styles.thumbLine} />
                </div>
              </div>
              <span className={styles.modeLabel}>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
