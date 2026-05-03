'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { Skill, SkillMeta } from '@/lib/types'
import { DESTRUCTIVE_TOOLS } from '@/lib/skill-parser'
import { MarkdownRenderer } from '@/components'
import { useToast } from '@/context/ToastContext'
import sharedStyles from './SettingsPage.module.css'
import styles from './SkillsSection.module.css'

interface SkillDetailViewProps {
  skillId: string
  onBack: () => void
  onEdit: () => void
  onDelete: (skill: SkillMeta) => void
}

interface SkillWithRaw extends Skill {
  rawMarkdown?: string
}

export function SkillDetailView({ skillId, onBack, onEdit, onDelete }: SkillDetailViewProps) {
  const { toast } = useToast()
  const [skill, setSkill] = useState<SkillWithRaw | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/skills/${skillId}`)
        if (!res.ok) {
          if (!cancelled) toast({ intent: 'error', title: 'Failed to load skill' })
          return
        }
        const data = await res.json()
        if (!cancelled) setSkill(data.skill ?? null)
      } catch {
        if (!cancelled) toast({ intent: 'error', title: 'Network error' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [skillId, toast])

  if (loading) {
    return <p className={sharedStyles.keyStatusText}>Loading skill…</p>
  }
  if (!skill) {
    return (
      <section className={sharedStyles.section}>
        <div className={styles.detailHeader}>
          <div className={styles.detailTitleGroup}>
            <button type="button" className={styles.editorBack} onClick={onBack}>
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back to skills
            </button>
          </div>
        </div>
        <p className={sharedStyles.keyStatusText}>Skill not found.</p>
      </section>
    )
  }

  const usesDestructive = skill.requiredTools.some((t) => DESTRUCTIVE_TOOLS.has(t))

  return (
    <section className={sharedStyles.section}>
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleGroup}>
          <button type="button" className={styles.editorBack} onClick={onBack}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back to skills
          </button>
          <h2 className={sharedStyles.sectionTitle}>{skill.name || skill.id}</h2>
          <div className={styles.detailId}>{skill.id}</div>
        </div>
        <div className={styles.detailButtons}>
          <button type="button" className={sharedStyles.saveButton} onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionDelete}`}
            onClick={() => onDelete(skill)}
          >
            Delete
          </button>
        </div>
      </div>

      <div className={styles.detailMeta}>
        <div className={styles.detailMetaCell}>
          <div className={styles.previewLabel}>Required role</div>
          <div className={styles.previewValue}>
            <span
              className={`${styles.roleBadge} ${
                skill.requiredRole === 'admin' ? styles.roleBadgeAdmin : styles.roleBadgeReader
              }`}
            >
              {skill.requiredRole}
            </span>
            {usesDestructive && (
              <span className={styles.destructiveBadge}>uses destructive tools</span>
            )}
          </div>
        </div>
        <div className={styles.detailMetaCell}>
          <div className={styles.previewLabel}>Required tools</div>
          <div className={styles.previewValue}>
            {skill.requiredTools.length === 0 ? '—' : skill.requiredTools.join(', ')}
          </div>
        </div>
        <div className={styles.detailMetaCell}>
          <div className={styles.previewLabel}>Parameters</div>
          <div className={styles.previewValue}>
            {skill.parameters.length === 0 ? '—' : skill.parameters.join(', ')}
          </div>
        </div>
        <div className={styles.detailMetaCell}>
          <div className={styles.previewLabel}>Description</div>
          <div className={styles.previewValue}>{skill.description || '—'}</div>
        </div>
      </div>

      <div className={styles.detailContentBox}>
        <MarkdownRenderer content={skill.rawMarkdown ?? skill.instructions ?? ''} />
      </div>
    </section>
  )
}
