'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ProfileSection } from './ProfileSection'
import { AppearanceSection } from './AppearanceSection'
import { UsageSection } from './UsageSection'
import styles from './SettingsPage.module.css'

type Tab = 'general' | 'usage'

const TABS: { value: Tab; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'usage', label: 'Usage' },
]

export interface SettingsPageProps {
  userName: string
  userImage?: string
  className?: string
}

export function SettingsPage({ userName, userImage, className }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>('general')

  return (
    <div className={`${styles.container}${className ? ` ${className}` : ''}`}>
      <aside className={styles.sidebar} aria-label="Settings navigation">
        <Link href="/chat" className={styles.backLink}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to chat</span>
        </Link>
        <h1 className={styles.heading}>Settings</h1>
        <div role="tablist" aria-label="Settings sections" className={styles.navList}>
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`tab-${value}`}
              aria-controls={`panel-${value}`}
              aria-selected={activeTab === value}
              onClick={() => setActiveTab(value)}
              className={`${styles.navItem} ${activeTab === value ? styles.navItemActive : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      </aside>

      <main
        className={styles.content}
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'general' && (
          <>
            <ProfileSection userName={userName} userImage={userImage} />
            <AppearanceSection />
          </>
        )}
        {activeTab === 'usage' && <UsageSection />}
      </main>
    </div>
  )
}
