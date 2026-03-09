'use client'

import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import type { Conversation } from '@/lib/types'

const MAX_CACHE_SIZE = 10
const PREFETCH_STALE_MS = 30_000 // 30 seconds
const CONV_ID_RE = /^conv_[0-9a-f-]{36}$/i

interface CacheEntry {
  data: Conversation
  accessedAt: number
  fetchedAt: number
}

interface ConversationCacheValue {
  getCached: (id: string) => Conversation | null
  setCached: (id: string, conv: Conversation) => void
  invalidate: (id: string) => void
  prefetch: (id: string) => Promise<void>
}

const ConversationCacheContext = createContext<ConversationCacheValue | null>(null)

export function ConversationCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef(new Map<string, CacheEntry>())

  const evictLRU = useCallback(() => {
    const cache = cacheRef.current
    if (cache.size <= MAX_CACHE_SIZE) return

    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt
        oldestKey = key
      }
    }

    if (oldestKey) cache.delete(oldestKey)
  }, [])

  const getCached = useCallback((id: string): Conversation | null => {
    const entry = cacheRef.current.get(id)
    if (!entry) return null
    entry.accessedAt = Date.now()
    return entry.data
  }, [])

  const setCached = useCallback((id: string, conv: Conversation) => {
    const now = Date.now()
    cacheRef.current.set(id, { data: conv, accessedAt: now, fetchedAt: now })
    evictLRU()
  }, [evictLRU])

  const invalidate = useCallback((id: string) => {
    cacheRef.current.delete(id)
  }, [])

  const prefetch = useCallback(async (id: string) => {
    if (!CONV_ID_RE.test(id)) return
    const existing = cacheRef.current.get(id)
    if (existing && Date.now() - existing.fetchedAt < PREFETCH_STALE_MS) return

    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
      if (!res.ok) return
      const conv: Conversation = await res.json()
      const now = Date.now()
      cacheRef.current.set(id, {
        data: conv,
        accessedAt: existing?.accessedAt ?? now,
        fetchedAt: now,
      })
      evictLRU()
    } catch {
      // Prefetch is best-effort
    }
  }, [evictLRU])

  return (
    <ConversationCacheContext.Provider value={{ getCached, setCached, invalidate, prefetch }}>
      {children}
    </ConversationCacheContext.Provider>
  )
}

export function useConversationCache(): ConversationCacheValue {
  const ctx = useContext(ConversationCacheContext)
  if (!ctx) {
    throw new Error('useConversationCache must be used within ConversationCacheProvider')
  }
  return ctx
}
