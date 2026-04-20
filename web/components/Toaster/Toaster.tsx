'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useToast, type Toast as ToastModel, type ToastIntent } from '@/context/ToastContext'
import styles from './Toaster.module.css'

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
} as const

function intentRole(intent: ToastIntent): 'status' | 'alert' {
  // Status messages (success/info) are polite; alerts (error/warning) should
  // interrupt. This keeps the live-region semantics honest per WAI-ARIA.
  return intent === 'error' || intent === 'warning' ? 'alert' : 'status'
}

// Each toast manages its own auto-dismiss timer so we can pause on hover.
// Pausing means clearing the timer; resuming starts a fresh timer with the
// original duration (we don't bother tracking elapsed-ms for simplicity —
// hovering a toast implies the user wants to read it, so resetting the
// full timer once they move away is reasonable). We read `dismiss` from
// the context directly (rather than receiving it as a prop) because the
// parent's arrow is recreated on every render; a stable reference keeps
// this effect from restarting every time any other toast mounts/unmounts.
function ToastItem({ toast }: { toast: ToastModel }) {
  const { dismiss } = useToast()
  const [paused, setPaused] = useState(false)
  const Icon = ICONS[toast.intent]
  const variantClass = styles[toast.intent] ?? ''

  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs)
    return () => clearTimeout(timer)
  }, [paused, toast.durationMs, toast.id, dismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      role={intentRole(toast.intent)}
      className={`${styles.toast} ${variantClass}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          dismiss(toast.id)
        }
      }}
    >
      <Icon className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <div className={styles.title}>{toast.title}</div>
        {toast.description && (
          <div className={styles.description}>{toast.description}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className={styles.dismissBtn}
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
    </motion.div>
  )
}

export function Toaster() {
  const { toasts } = useToast()
  const [mounted, setMounted] = useState(false)

  // Portal target is the document body; only available after hydration.
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted || typeof document === 'undefined') return null

  // NOTE: no aria-live / aria-atomic on the container — each toast already
  // has role="status" (polite) or role="alert" (assertive), which carry
  // implicit live-region semantics. Layering aria-live on top causes double
  // announcements / politeness conflicts on some screen readers.
  return createPortal(
    <div className={styles.container}>
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}
