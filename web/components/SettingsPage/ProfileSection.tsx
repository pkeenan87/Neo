'use client'

import { useState, useEffect, useRef } from 'react'
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
  const [savedName, setSavedName] = useState('')
  const [isSaved, setIsSaved] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const existing = localStorage.getItem(DISPLAY_NAME_KEY) ?? ''
    setDisplayName(existing)
    setSavedName(existing)
  }, [])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  const handleChange = (value: string) => {
    const sanitized = value.replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_DISPLAY_NAME_LEN)
    setDisplayName(sanitized)
    setIsSaved(false)
  }

  const handleSave = () => {
    localStorage.setItem(DISPLAY_NAME_KEY, displayName)
    setSavedName(displayName)
    setIsSaved(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setIsSaved(false), 2000)
  }

  const hasChanges = displayName !== savedName

  return (
    <div className={`${styles.section}${className ? ` ${className}` : ''}`}>
      <h2 className={styles.sectionTitle}>Profile</h2>
      <UserAvatar src={userImage} userName={userName} size={48} decorative />
      <div className={styles.profileFieldWide}>
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
      <div className={styles.profileFieldWide}>
        <label className={styles.fieldLabel} htmlFor="display-name">
          What should Neo call you?
        </label>
        <input
          id="display-name"
          type="text"
          value={displayName}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hasChanges) handleSave() }}
          maxLength={MAX_DISPLAY_NAME_LEN}
          placeholder={userName}
          className={styles.fieldInput}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges}
          className={styles.saveButton}
        >
          {isSaved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
