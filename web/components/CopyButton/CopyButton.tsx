'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Check, AlertCircle } from 'lucide-react'
import styles from './CopyButton.module.css'

export type CopyButtonSize = 'sm' | 'md'
export type CopyButtonVariant = 'text' | 'icon'
type Status = 'idle' | 'copied' | 'failed'

export interface CopyButtonProps {
  /** The text to copy to the clipboard. Required. */
  text: string
  /** Accessible label for the icon variant. Falls back to "Copy to clipboard".
   *  Ignored for variant="text" — the visible "Copy" text becomes the accessible name
   *  (WCAG 2.5.3 Label in Name). */
  label?: string
  /** Visual size. Defaults to 'sm'. */
  size?: CopyButtonSize
  /** 'icon' shows the Copy/Check/AlertCircle icons; 'text' shows "Copy"/"Copied!"/"Copy failed". */
  variant?: CopyButtonVariant
  /** Optional class forwarded to the outermost element. */
  className?: string
}

const IDLE_LABEL_FALLBACK = 'Copy to clipboard'
const REVERT_MS = 2000

function execCommandFallback(text: string): boolean {
  // Pre-Clipboard-API path. Runs only when navigator.clipboard.writeText is
  // unavailable or throws (insecure context, old Safari, iframe with
  // restrictive permissions policy).
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // Hide from the accessibility tree and the tab order so the briefly
    // mounted textarea isn't detectable by assistive tech or focusable
    // via keyboard during the synchronous copy.
    ta.setAttribute('aria-hidden', 'true')
    ta.setAttribute('tabindex', '-1')
    ta.style.position = 'absolute'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyButton({
  text,
  label,
  size = 'sm',
  variant = 'icon',
  className,
}: CopyButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear any pending revert timer on unmount so a click → unmount mid-flight
  // doesn't produce a setState-on-unmounted-component warning.
  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== null) {
        clearTimeout(revertTimerRef.current)
      }
    }
  }, [])

  const schedule = useCallback((next: Exclude<Status, 'idle'>) => {
    setStatus(next)
    if (revertTimerRef.current !== null) {
      clearTimeout(revertTimerRef.current)
    }
    revertTimerRef.current = setTimeout(() => {
      setStatus('idle')
      revertTimerRef.current = null
    }, REVERT_MS)
  }, [])

  const handleCopy = useCallback(async () => {
    let ok = false
    const hasClipboard =
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.writeText === 'function'
    if (hasClipboard) {
      try {
        await navigator.clipboard.writeText(text)
        ok = true
      } catch {
        ok = execCommandFallback(text)
      }
    } else {
      ok = execCommandFallback(text)
    }
    schedule(ok ? 'copied' : 'failed')
  }, [text, schedule])

  const iconSize = size === 'md' ? 20 : 16
  const renderIcon = () => {
    if (status === 'copied') return <Check size={iconSize} aria-hidden="true" />
    if (status === 'failed') return <AlertCircle size={iconSize} aria-hidden="true" />
    return <Copy size={iconSize} aria-hidden="true" />
  }
  const renderText = () => {
    if (status === 'copied') return 'Copied!'
    if (status === 'failed') return 'Copy failed'
    return 'Copy'
  }

  const classes = [
    styles.button,
    styles[size],
    styles[variant],
    status === 'copied' && styles.copied,
    status === 'failed' && styles.failed,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  // For variant="text", the visible "Copy"/"Copied!"/"Copy failed" text serves as
  // the accessible name (WCAG 2.5.3 Label in Name). For variant="icon", we supply
  // a static aria-label — the transient status ("Copied to clipboard" / "Copy failed")
  // is announced via the sr-only aria-live region below, which avoids SR bugs
  // where a changing aria-label on a focused element is not re-announced.
  const iconAriaLabel = label ?? IDLE_LABEL_FALLBACK
  const liveMessage =
    status === 'copied'
      ? 'Copied to clipboard'
      : status === 'failed'
      ? 'Copy failed'
      : ''

  // The aria-live span is rendered as a sibling of the button (not a child) so
  // it doesn't leak into the button's textContent — and because a live region
  // nested in a focusable control is a questionable ARIA pattern.
  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={variant === 'icon' ? iconAriaLabel : undefined}
        className={classes}
      >
        {variant === 'icon' ? renderIcon() : renderText()}
      </button>
      <span role="status" aria-live="polite" className={styles.srOnly}>
        {liveMessage}
      </span>
    </>
  )
}
