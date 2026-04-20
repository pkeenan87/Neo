'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ToastIntent = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  intent: ToastIntent
  title: string
  description?: string
  durationMs: number
}

export interface ToastInput {
  intent?: ToastIntent
  title: string
  description?: string
  durationMs?: number
}

interface ToastContextValue {
  toasts: Toast[]
  toast: (input: ToastInput) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

// Transient feedback (save, copy, error) defaults to 4s — long enough to
// catch, short enough that the toast doesn't pile up during a stream of
// actions. Callers can pass `durationMs` to override for important messages.
const DEFAULT_DURATION_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((input: ToastInput): string => {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const newToast: Toast = {
      id,
      intent: input.intent ?? 'info',
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
    }
    setToasts((prev) => [...prev, newToast])
    return id
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, toast, dismiss }),
    [toasts, toast, dismiss],
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>')
  }
  return ctx
}
