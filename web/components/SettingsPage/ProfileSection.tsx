'use client'

import { useState, useEffect } from 'react'
import { UserAvatar } from '@/components'
import styles from './SettingsPage.module.css'

export interface ProfileSectionProps {
  userName: string
  userImage?: string
  className?: string
}

const DISPLAY_NAME_KEY = 'neo-display-name'
const MAX_DISPLAY_NAME_LEN = 50

export function ProfileSection({ userName, userImage, className }: ProfileSectionProps) {
  const [displayName, setDisplayName] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem(DISPLAY_NAME_KEY)
    if (saved) setDisplayName(saved)
  }, [])

  const handleDisplayNameChange = (value: string) => {
    const sanitized = value.replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_DISPLAY_NAME_LEN)
    setDisplayName(sanitized)
    localStorage.setItem(DISPLAY_NAME_KEY, sanitized)
  }

  return (
    <div className={`${styles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={styles.sectionTitle}>Profile</h2>
      <div className={styles.profileRow}>
        <UserAvatar src={userImage} userName={userName} size={48} decorative />
        <div className={styles.profileField}>
          <label className={styles.fieldLabel} htmlFor="profile-full-name">Full name</label>
          <input
            id="profile-full-name"
            type="text"
            value={userName}
            readOnly
            aria-readonly="true"
            className={styles.fieldInput}
          />
        </div>
      </div>
      <div className={styles.profileFieldWide}>
        <label className={styles.fieldLabel} htmlFor="display-name">
          What should Neo call you?
        </label>
        <input
          id="display-name"
          type="text"
          value={displayName}
          onChange={(e) => handleDisplayNameChange(e.target.value)}
          maxLength={MAX_DISPLAY_NAME_LEN}
          placeholder={userName}
          className={styles.fieldInput}
        />
      </div>
    </div>
  )
}
