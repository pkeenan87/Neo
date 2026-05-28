'use client'

import { useCallback } from 'react'
import styles from './ContextTierSelector.module.css'

/**
 * Two-tier context-window selector exposed next to the chat send
 * button. Default is the 200K tier (Sonnet 4-6); operators opt in to
 * the 1M tier (Opus 4.7 `[1m]`) at the start of a conversation. The
 * 1M tier is priced ~10× the default — the tooltip surfaces this so
 * the choice is deliberate.
 *
 * Once a conversation has at least one message the selector is locked
 * (`disabled={true}`), enforcing the "tier chosen at start, never
 * mid-conversation" contract that the server also re-checks against
 * the persisted Session.model.
 */
export type ContextTier = '200k' | '1m'

export interface ContextTierSelectorProps {
  value: ContextTier
  onChange: (next: ContextTier) => void
  /** True once the conversation has 1+ persisted message. Disables
   *  the control so the tier can't switch mid-conversation. */
  locked: boolean
  /** Optional disable while a request is in flight. Distinct from
   *  `locked` so the lock reason can be surfaced separately. */
  disabled?: boolean
  className?: string
}

const OPTIONS: { value: ContextTier; label: string; modelId: string; cost: string }[] = [
  { value: '200k', label: '200K', modelId: 'claude-sonnet-4-6', cost: 'Sonnet · standard pricing' },
  { value: '1m', label: '1M', modelId: 'claude-opus-4-7[1m]', cost: 'Opus 4.7 · ~10× cost' },
]

export function ContextTierSelector({
  value,
  onChange,
  locked,
  disabled,
  className,
}: ContextTierSelectorProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as ContextTier
      if (next === '200k' || next === '1m') onChange(next)
    },
    [onChange],
  )

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]
  const isDisabled = locked || disabled
  const title = locked
    ? `Context tier is locked to ${current.label} for this conversation. Start a new chat to change.`
    : `${current.cost}. Locked after the first message.`

  return (
    <div className={`${styles.wrapper}${className ? ` ${className}` : ''}`}>
      <label className={styles.label} htmlFor="context-tier-select">
        <span className="sr-only">Context tier</span>
        <select
          id="context-tier-select"
          className={styles.select}
          value={value}
          onChange={handleChange}
          disabled={isDisabled}
          title={title}
          aria-label={`Context tier: ${current.label}. ${title}`}
        >
          {OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/**
 * Map a context tier to the Anthropic model id sent in the agent
 * request. Kept here (next to the OPTIONS table) so adding a new
 * tier later only touches this file.
 */
export function modelIdForTier(tier: ContextTier): string {
  const opt = OPTIONS.find((o) => o.value === tier)
  return opt?.modelId ?? OPTIONS[0].modelId
}

/**
 * Inverse: given a model id persisted on a conversation, infer which
 * tier the selector should display. Used on conversation resume so
 * the (locked) selector reflects the chosen tier.
 */
export function tierForModelId(modelId: string | undefined): ContextTier {
  if (modelId && modelId.endsWith('[1m]')) return '1m'
  return '200k'
}
