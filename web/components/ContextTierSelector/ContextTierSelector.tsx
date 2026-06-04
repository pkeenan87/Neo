'use client'

import { useCallback } from 'react'
import styles from './ContextTierSelector.module.css'

/**
 * Two-option model selector exposed next to the chat send button.
 * The user picks Sonnet (default, cheap, ~5× less expensive) or Opus
 * (heavier reasoning, full 1M context). Once a conversation has at
 * least one persisted message the control is locked, enforcing the
 * "model chosen at start, never mid-conversation" contract that the
 * server also re-checks against session.model.
 *
 * Component naming preserves the original `ContextTier` terminology
 * (and the `'200k' | '1m'` literal values) for stability — Cosmos
 * persistence and the chat state machine depend on them. Only the
 * displayed labels, costs, and underlying model ids changed when we
 * collapsed the legacy 200K/1M tier split (Opus 4.7 [1m] cost 2× the
 * standard rate) into a single Sonnet-vs-Opus model picker on Opus
 * 4.8 (1M is the default, no premium).
 */
export type ContextTier = '200k' | '1m'

export interface ContextTierSelectorProps {
  value: ContextTier
  onChange: (next: ContextTier) => void
  /** True once the conversation has 1+ persisted message. Disables
   *  the control so the model can't switch mid-conversation. */
  locked: boolean
  /** Optional disable while a request is in flight. Distinct from
   *  `locked` so the lock reason can be surfaced separately. */
  disabled?: boolean
  className?: string
}

const OPTIONS: { value: ContextTier; label: string; modelId: string; displayName: string; cost: string }[] = [
  {
    value: '200k',
    label: 'Sonnet',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    cost: 'Sonnet · standard pricing',
  },
  {
    value: '1m',
    label: 'Opus',
    modelId: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    cost: 'Opus 4.8 · 1M context · ~5× Sonnet',
  },
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
    ? `Model is locked to ${current.label} for this conversation. Start a new chat to change.`
    : `${current.cost}. Locked after the first message.`

  return (
    <div className={`${styles.wrapper}${className ? ` ${className}` : ''}`}>
      <label className={styles.label} htmlFor="context-tier-select">
        <span className="sr-only">Model</span>
        <select
          id="context-tier-select"
          className={styles.select}
          value={value}
          onChange={handleChange}
          disabled={isDisabled}
          title={title}
          aria-label={`Model: ${current.label}. ${title}`}
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
 * Map a tier value to the Anthropic model id sent in the agent
 * request. Kept here (next to the OPTIONS table) so adding a new
 * model later only touches this file.
 */
export function modelIdForTier(tier: ContextTier): string {
  const opt = OPTIONS.find((o) => o.value === tier)
  return opt?.modelId ?? OPTIONS[0].modelId
}

/**
 * Inverse: given a model id persisted on a conversation, infer which
 * tier the selector should display. Used on conversation resume so
 * the (locked) selector reflects the chosen model. Legacy `[1m]`-
 * suffixed ids collapse to the `'1m'` tier alongside Opus 4.8 so
 * resumed conversations show the Opus label.
 */
export function tierForModelId(modelId: string | undefined): ContextTier {
  if (!modelId) return '200k'
  if (modelId.endsWith('[1m]')) return '1m'
  if (modelId === 'claude-opus-4-8') return '1m'
  return '200k'
}

/**
 * Human-readable display name for the chat header's
 * "Powered by …" badge. Same source of truth as the OPTIONS table
 * so adding a new model updates the badge automatically.
 */
export function displayNameForTier(tier: ContextTier): string {
  const opt = OPTIONS.find((o) => o.value === tier)
  return opt?.displayName ?? OPTIONS[0].displayName
}
