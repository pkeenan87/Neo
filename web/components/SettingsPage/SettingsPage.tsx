'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ProfileSection } from './ProfileSection'
import { AppearanceSection } from './AppearanceSection'
import { UsageSection } from './UsageSection'
import { ApiKeysSection } from './ApiKeysSection'
import styles from './SettingsPage.module.css'

type Tab = 'general' | 'usage' | 'api-keys'

const BASE_TABS: { value: Tab; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'usage', label: 'Usage' },
]

export interface SettingsPageProps {
  userName: string
  userImage?: string
  userRole?: string
  className?: string
}

export function SettingsPage({ userName, userImage, userRole, className }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>('general')

  const tabs = userRole === 'admin'
    ? [...BASE_TABS, { value: 'api-keys' as Tab, label: 'API Keys' }]
    : BASE_TABS

  return (
    <div className={`${styles.container}${className ? ` ${className}` : ''}`}>
      <aside className={styles.sidebar} aria-label="Settings navigation">
        <Link href="/chat" className={styles.backLink}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to chat</span>
        </Link>
        <h1 className={styles.heading}>Settings</h1>
        <div role="tablist" aria-label="Settings sections" className={styles.navList}>
          {tabs.map(({ value, label }) => (
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
        {activeTab === 'api-keys' && <ApiKeysSection />}
      </main>
    </div>
  )
}
