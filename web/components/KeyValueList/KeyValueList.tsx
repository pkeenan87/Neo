'use client'

import { useId } from 'react'
import styles from './KeyValueList.module.css'

export interface KeyValueEntry {
  key: string
  value: string
}

export interface KeyValueListProps {
  entries: KeyValueEntry[]
  onChange: (entries: KeyValueEntry[]) => void
  keyLabel?: string
  valueLabel?: string
  addLabel?: string
  emptyLabel?: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  className?: string
}

/**
 * Generic editor for an ordered list of { key, value } string pairs.
 * Caller owns the source of truth; this component is fully controlled.
 * Rows are keyed by index because the underlying data has no stable
 * identifier — losing focus on every keystroke is the alternative.
 *
 * Currently used by the scheduled-task editor for `variables`.
 */
export function KeyValueList({
  entries,
  onChange,
  keyLabel = 'Key',
  valueLabel = 'Value',
  addLabel = 'Add row',
  emptyLabel = 'No entries.',
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  className,
}: KeyValueListProps) {
  const idPrefix = useId()

  function updateRow(index: number, patch: Partial<KeyValueEntry>) {
    const next = [...entries]
    next[index] = { ...next[index], ...patch }
    onChange(next)
  }

  function removeRow(index: number) {
    onChange(entries.filter((_, i) => i !== index))
  }

  function addRow() {
    onChange([...entries, { key: '', value: '' }])
  }

  return (
    <div className={className ? `${styles.root} ${className}` : styles.root}>
      {entries.length === 0 && <p className={styles.empty}>{emptyLabel}</p>}
      {entries.map((row, index) => {
        const keyId = `${idPrefix}-key-${index}`
        const valueId = `${idPrefix}-value-${index}`
        return (
          <div key={index} className={styles.row}>
            <label htmlFor={keyId} className={styles.srOnly}>
              {keyLabel} {index + 1}
            </label>
            <input
              id={keyId}
              type="text"
              className={styles.input}
              value={row.key}
              onChange={(e) => updateRow(index, { key: e.target.value })}
              placeholder={keyPlaceholder}
            />
            <label htmlFor={valueId} className={styles.srOnly}>
              {valueLabel} {index + 1}
            </label>
            <input
              id={valueId}
              type="text"
              className={styles.input}
              value={row.value}
              onChange={(e) => updateRow(index, { value: e.target.value })}
              placeholder={valuePlaceholder}
            />
            <button
              type="button"
              className={styles.removeButton}
              onClick={() => removeRow(index)}
              aria-label={`Remove ${keyLabel.toLowerCase()} ${index + 1}`}
            >
              Remove
            </button>
          </div>
        )
      })}
      <button type="button" className={styles.addButton} onClick={addRow}>
        {addLabel}
      </button>
    </div>
  )
}
