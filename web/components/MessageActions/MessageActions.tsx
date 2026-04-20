'use client'

import { CopyButton } from '@/components'
import styles from './MessageActions.module.css'

export interface MessageActionsProps {
  /** The raw markdown-source content of the assistant message to copy. */
  content: string
  /** Optional class forwarded to the toolbar root. */
  className?: string
  // Future Phase 2 additions (thumbs-up / thumbs-down / regenerate) will slot
  // in here as additional optional props, and the toolbar will render
  // sibling buttons next to the copy affordance.
}

/**
 * Action row rendered below a completed assistant message. Phase 1 contains
 * a single CopyButton. A11y note: role="toolbar" is deliberately NOT applied
 * while there is only one action, since that role implies arrow-key
 * navigation that doesn't exist yet. When Phase 2 lands (thumbs-up /
 * thumbs-down / regenerate), re-introduce role="toolbar" together with
 * roving-tabindex keyboard navigation per the WAI-ARIA toolbar pattern.
 */
export function MessageActions({ content, className }: MessageActionsProps) {
  const classes = [styles.toolbar, className].filter(Boolean).join(' ')
  return (
    <div className={classes}>
      <CopyButton text={content} label="Copy message to clipboard" />
    </div>
  )
}
