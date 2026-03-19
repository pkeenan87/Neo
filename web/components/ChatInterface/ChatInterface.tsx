'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { AnimatePresence, motion } from 'motion/react'
import {
  Plus,
  MessageSquare,
  Settings,
  Download,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowUp,
  Sun,
  Moon,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { useTheme } from '@/context/ThemeContext'
import { useConversationCache } from '@/context/ConversationCacheContext'
import { MarkdownRenderer, ThinkingBubble, UserAvatar } from '@/components'
import styles from './ChatInterface.module.css'
import type { Conversation, ConversationMeta, PendingTool } from '@/lib/types'

// ─────────────────────────────────────────────────────────────
//  Types for NDJSON stream events and content blocks
// ─────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolsUsed?: string[]
  skillBadge?: string
}

interface SessionEvent { type: 'session'; sessionId: string }
interface ThinkingEvent { type: 'thinking' }
interface ToolCallEvent { type: 'tool_call'; tool: string; input: Record<string, unknown> }
interface ConfirmationEvent { type: 'confirmation_required'; tool: PendingTool }
interface ResponseEvent { type: 'response'; text: string }
interface ErrorEvent { type: 'error'; message: string; code?: string }
interface SkillInvocationEvent { type: 'skill_invocation'; skill: { id: string; name: string } }

type StreamEvent =
  | SessionEvent
  | ThinkingEvent
  | ToolCallEvent
  | ConfirmationEvent
  | ResponseEvent
  | ErrorEvent
  | SkillInvocationEvent

interface TextBlock { type: 'text'; text: string }

function isTextBlock(b: unknown): b is TextBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as TextBlock).type === 'text' &&
    typeof (b as TextBlock).text === 'string'
  )
}

// Detect intermediate assistant turns (tool-use reasoning) that should not
// be shown on conversation reload. During live streaming only the final
// "response" event is rendered; this filter replicates that behavior.
// Also defensively covers "thinking" / "redacted_thinking" blocks in case
// extended thinking is enabled in the future.
function isIntermediateAssistantTurn(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    (b: unknown) =>
      typeof b === 'object' &&
      b !== null &&
      ((b as { type: string }).type === 'tool_use' ||
       (b as { type: string }).type === 'thinking' ||
       (b as { type: string }).type === 'redacted_thinking'),
  )
}

function isStreamEvent(e: unknown): e is StreamEvent {
  return typeof e === 'object' && e !== null && typeof (e as StreamEvent).type === 'string'
}

// ─────────────────────────────────────────────────────────────
//  Props & constants
// ─────────────────────────────────────────────────────────────

export interface ChatInterfaceProps {
  onLogout: () => void
  userName?: string
  userRole?: string
  userImage?: string
  initialConversations?: ConversationMeta[]
  initialConversation?: Conversation
  className?: string
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'init-1',
    role: 'assistant',
    content:
      'System initialized. I am Neo, your autonomous security operations agent. How can I assist with your perimeter defense today?',
  },
]

const MAX_TITLE_LENGTH = 200

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ─────────────────────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────────────────────

function conversationToChatMessages(conv: Conversation): ChatMessage[] {
  const chatMessages: ChatMessage[] = []
  for (const msg of conv.messages ?? []) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      // Skip intermediate assistant turns (tool-use reasoning / thinking)
      // so reload matches the live streaming experience where only the
      // final response is shown.
      if (msg.role === 'assistant' && isIntermediateAssistantTurn(msg.content)) {
        continue
      }
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(isTextBlock).map((b: TextBlock) => b.text).join('\n')
          : ''
      if (content) {
        chatMessages.push({
          id: crypto.randomUUID(),
          role: msg.role,
          content,
        })
      }
    }
  }
  return chatMessages
}

export function ChatInterface({
  onLogout,
  userName = 'Operator',
  userRole = 'Reader',
  userImage,
  initialConversations = [],
  initialConversation,
  className,
}: ChatInterfaceProps) {
  const { theme, toggleTheme } = useTheme()
  const cache = useConversationCache()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (initialConversation) {
      const loaded = conversationToChatMessages(initialConversation)
      return loaded.length > 0 ? loaded : INITIAL_MESSAGES
    }
    return INITIAL_MESSAGES
  })
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activeConversationId, _setActiveConversationId] = useState<string | null>(
    initialConversation?.id ?? null
  )
  const [conversations, setConversations] = useState<ConversationMeta[]>(initialConversations)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTitleValue, setEditingTitleValue] = useState('')
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingTool | null>(
    initialConversation?.pendingConfirmation ?? null
  )
  const [currentToolName, setCurrentToolName] = useState<string | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashSkills, setSlashSkills] = useState<Array<{ id: string; name: string; description: string; parameters: string[] }>>([])
  const slashFetchedRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const isDark = theme === 'dark'

  // Ref to keep activeConversationId current inside async closures
  const activeConversationIdRef = useRef<string | null>(initialConversation?.id ?? null)
  const setActiveConversationId = (id: string | null) => {
    activeConversationIdRef.current = id
    _setActiveConversationId(id)
  }

  // Cache the initial conversation if provided
  useEffect(() => {
    if (initialConversation) {
      cache.setCached(initialConversation.id, initialConversation)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConversation])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '3.5rem'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [inputValue])

  useEffect(() => {
    if (editingTitleId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTitleId])

  // Focus the confirm button when a confirmation appears
  useEffect(() => {
    if (pendingConfirmation && confirmBtnRef.current) {
      confirmBtnRef.current.focus()
    }
  }, [pendingConfirmation])

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations?channel=web')
      if (res.ok) {
        const data = await res.json()
        setConversations(data.conversations ?? [])
      }
    } catch (err) {
      console.error('[refreshConversations]', err)
    }
  }, [])

  const applyConversation = useCallback((id: string, conv: Conversation) => {
    setActiveConversationId(id)
    setPendingConfirmation(conv.pendingConfirmation ?? null)
    const chatMessages = conversationToChatMessages(conv)
    setMessages(chatMessages.length > 0 ? chatMessages : INITIAL_MESSAGES)
    window.history.pushState({}, '', `/chat/${id}`)
    document.title = conv.title ? `${conv.title} — Neo` : 'Neo'
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    // Serve from cache immediately (stale-while-revalidate)
    const cached = cache.getCached(id)
    if (cached) {
      applyConversation(id, cached)
    }

    // Always revalidate from server
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
      if (!res.ok) {
        if (!cached) console.error('[loadConversation] Server returned', res.status)
        return
      }

      const conv: Conversation = await res.json()
      cache.setCached(id, conv)

      // Apply fresh data if user hasn't navigated away, or if there was no cache hit
      const isStillActive = activeConversationIdRef.current === id
      if (isStillActive || !cached) {
        applyConversation(id, conv)
      }
    } catch (err) {
      if (!cached) console.error('[loadConversation]', err)
    }
  }, [applyConversation, cache])

  const handleNewConversation = () => {
    setActiveConversationId(null)
    setMessages(INITIAL_MESSAGES)
    setPendingConfirmation(null)
    window.history.pushState({}, '', '/chat')
    document.title = 'Neo'
  }

  const handleDeleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        console.error('[handleDeleteConversation] Server returned', res.status)
        return
      }
      setConversations(prev => prev.filter(c => c.id !== id))
      if (activeConversationIdRef.current === id) {
        handleNewConversation()
      }
    } catch (err) {
      console.error('[handleDeleteConversation]', err)
    }
  }

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingTitleId(id)
    setEditingTitleValue(currentTitle || '')
  }

  const handleSaveRename = async () => {
    if (!editingTitleId || !editingTitleValue.trim()) {
      setEditingTitleId(null)
      return
    }

    const trimmed = editingTitleValue.trim().slice(0, MAX_TITLE_LENGTH)

    try {
      const res = await fetch(`/api/conversations/${editingTitleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
      if (res.ok) {
        setConversations(prev =>
          prev.map(c =>
            c.id === editingTitleId ? { ...c, title: trimmed } : c
          )
        )
      } else {
        console.error('[handleSaveRename] Server returned', res.status)
      }
    } catch (err) {
      console.error('[handleSaveRename]', err)
    }
    setEditingTitleId(null)
  }

  const handleConfirmAction = async (confirmed: boolean) => {
    if (!pendingConfirmation || !activeConversationIdRef.current) return

    const savedPending = pendingConfirmation
    setIsLoading(true)

    try {
      const res = await fetch('/api/agent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeConversationIdRef.current,
          toolId: savedPending.id,
          confirmed,
        }),
      })

      if (!res.ok) {
        setMessages(prev => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', content: 'Error processing confirmation.' },
        ])
        return
      }

      // Only clear pending after successful response
      setPendingConfirmation(null)

      const reader = res.body?.getReader()
      if (!reader) return

      await processNDJSONStream(reader)
    } catch (err) {
      console.error('[handleConfirmAction]', err)
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Connection error during confirmation.' },
      ])
    } finally {
      setIsLoading(false)
      if (activeConversationIdRef.current) {
        cache.invalidate(activeConversationIdRef.current)
      }
      void refreshConversations()
    }
  }

  const processNDJSONStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buffer = ''
    const MAX_TOOLS = 50
    const toolsUsed: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isStreamEvent(parsed)) continue
          const event = parsed

          switch (event.type) {
            case 'session':
              if (!activeConversationIdRef.current) {
                setActiveConversationId(event.sessionId)
                window.history.replaceState({}, '', `/chat/${event.sessionId}`)
              }
              break
            case 'thinking':
              setIsThinking(true)
              break
            case 'tool_call':
              setIsThinking(false)
              if (toolsUsed.length < MAX_TOOLS) {
                toolsUsed.push(event.tool)
              }
              setCurrentToolName(event.tool)
              break
            case 'confirmation_required':
              setIsThinking(false)
              setPendingConfirmation(event.tool)
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `Action requires confirmation: **${event.tool.name}**\n\n${Object.entries(event.tool.input).map(([k, v]) => `- ${k}: ${String(v)}`).join('\n')}`,
                },
              ])
              break
            case 'response':
              setIsThinking(false)
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: event.text,
                  toolsUsed: toolsUsed.length > 0 ? [...toolsUsed] : undefined,
                },
              ])
              break
            case 'skill_invocation':
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: '',
                  skillBadge: event.skill.name,
                },
              ])
              break
            case 'error':
              setIsThinking(false)
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `Error: ${event.message}`,
                  toolsUsed: toolsUsed.length > 0 ? [...toolsUsed] : undefined,
                },
              ])
              break
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    setCurrentToolName(null)
    setIsThinking(false)
  }

  // Slash command helpers
  const fetchSlashSkills = useCallback(async () => {
    if (slashFetchedRef.current) return
    try {
      const res = await fetch('/api/skills')
      if (res.ok) {
        const data = await res.json()
        const skills = data.skills ?? []
        setSlashSkills(skills)
        if (skills.length > 0) {
          slashFetchedRef.current = true
        }
      }
    } catch {
      // Silent — will retry on next /
    }
  }, [])

  const filteredSkills = useMemo(() => {
    const q = slashFilter.toLowerCase()
    return slashSkills.filter(
      (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    )
  }, [slashFilter, slashSkills])

  const handleSlashInputChange = useCallback((value: string) => {
    setInputValue(value)
    if (value.startsWith('/') && !value.includes(' ')) {
      void fetchSlashSkills()
      setSlashFilter(value.slice(1))
      setSlashMenuOpen(true)
      setSlashSelectedIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }, [fetchSlashSkills])

  const sendMessageRef = useRef<((msg?: string) => Promise<void>) | null>(null)

  const handleSlashSelect = useCallback((skill: { id: string; parameters: string[] }) => {
    setSlashMenuOpen(false)
    if (skill.parameters.length > 0) {
      setInputValue(`/${skill.id} `)
      textareaRef.current?.focus()
    } else {
      setInputValue('')
      void sendMessageRef.current?.(`/${skill.id}`)
    }
  }, [])

  const handleSlashKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!slashMenuOpen) return
    if (filteredSkills.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashSelectedIndex((prev) => (prev + 1) % filteredSkills.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      handleSlashSelect(filteredSkills[slashSelectedIndex])
    } else if (e.key === 'Escape') {
      setSlashMenuOpen(false)
    }
  }, [slashMenuOpen, filteredSkills, slashSelectedIndex, handleSlashSelect])

  const handleSendMessage = async (messageOverride?: string) => {
    const msg = messageOverride ?? inputValue
    if (!msg.trim() || isLoading) return

    const userMessage = msg
    setInputValue('')
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMessage }])
    setIsLoading(true)

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeConversationIdRef.current,
          message: userMessage,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }))
        setMessages(prev => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${err.error}` },
        ])
        return
      }

      const reader = res.body?.getReader()
      if (!reader) return

      await processNDJSONStream(reader)
    } catch (err) {
      console.error('[handleSendMessage]', err)
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Connection error. Please try again.' },
      ])
    } finally {
      setIsLoading(false)
      if (activeConversationIdRef.current) {
        cache.invalidate(activeConversationIdRef.current)
      }
      void refreshConversations()
    }
  }

  // Keep ref in sync so handleSlashSelect can call it without a circular dependency
  sendMessageRef.current = handleSendMessage

  // Handle browser back/forward navigation (Step 10)
  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(/^\/chat\/(conv_[0-9a-f-]+)\/?$/i)
      if (match) {
        const id = match[1]
        if (id !== activeConversationIdRef.current) {
          void loadConversation(id)
        }
      } else if (window.location.pathname === '/chat') {
        if (activeConversationIdRef.current) {
          setActiveConversationId(null)
          setMessages(INITIAL_MESSAGES)
          setPendingConfirmation(null)
        }
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [loadConversation])

  return (
    <div className={`${styles.container} ${className ?? ''}`}>
      {/* ── Sidebar ─── */}
      <motion.aside
        initial={false}
        animate={{ width: isSidebarOpen ? 280 : 0, opacity: isSidebarOpen ? 1 : 0 }}
        className={styles.sidebar}
        aria-label="Navigation sidebar"
        {...(!isSidebarOpen ? { inert: true } : {})}
      >
        {/* Sidebar header */}
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarBrandRow}>
            <Image src="/neo-icon.png" alt="" width={20} height={20} className="rounded shrink-0" />
            <span className={styles.sidebarBrand}>NEO</span>
          </div>
        </div>

        {/* Sidebar body */}
        <div className={styles.sidebarBody}>
          <button className={styles.newOpBtn} onClick={handleNewConversation}>
            <Plus className="w-4 h-4" />
            <span>New Operation</span>
          </button>

          <nav aria-label="Recent conversations">
            <div className={styles.sectionLabel}>
              Recent Conversations
            </div>
            {conversations.length === 0 && (
              <div className={styles.emptyState}>No conversations yet</div>
            )}
            {conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                className={`${styles.conversationItem} ${conv.id === activeConversationId ? styles.conversationItemActive : ''}`}
                onClick={() => loadConversation(conv.id)}
                onMouseEnter={() => cache.prefetch(conv.id)}
                aria-current={conv.id === activeConversationId ? 'true' : undefined}
              >
                {editingTitleId === conv.id ? (
                  <div className={styles.editTitleRow}>
                    <input
                      ref={editInputRef}
                      className={styles.editTitleInput}
                      value={editingTitleValue}
                      onChange={(e) => setEditingTitleValue(e.target.value)}
                      maxLength={MAX_TITLE_LENGTH}
                      aria-label="Conversation title"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { void handleSaveRename(); e.stopPropagation() }
                        if (e.key === 'Escape') { setEditingTitleId(null); e.stopPropagation() }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      className={styles.editTitleBtn}
                      onClick={(e) => { e.stopPropagation(); void handleSaveRename() }}
                      aria-label="Save title"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      className={styles.editTitleBtn}
                      onClick={(e) => { e.stopPropagation(); setEditingTitleId(null) }}
                      aria-label="Cancel rename"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <div className={styles.conversationInfo}>
                      <span className={styles.conversationTitle}>
                        {conv.title || 'New conversation'}
                      </span>
                      <span className={styles.conversationTimestamp}>
                        {relativeTime(conv.updatedAt)}
                      </span>
                    </div>
                    <div className={styles.conversationActions}>
                      <button
                        type="button"
                        className={styles.conversationActionBtn}
                        onClick={(e) => handleStartRename(conv.id, conv.title || '', e)}
                        aria-label="Rename conversation"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        className={styles.conversationActionBtn}
                        onClick={(e) => { void handleDeleteConversation(conv.id, e) }}
                        aria-label="Delete conversation"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* User profile + logout */}
        <div className={styles.sidebarFooter}>
          <div className={styles.userRow}>
            <UserAvatar src={userImage} userName={userName} size={32} className={styles.avatar} />
            <div className={styles.userInfo}>
              <div className={styles.userName}>{userName}</div>
              <div className={styles.clearance}>
                {userRole}
              </div>
            </div>
            <Link href="/downloads" aria-label="Download CLI" className={styles.downloadButton}>
              <Download className="w-4 h-4" />
            </Link>
            <Link href="/settings" aria-label="Settings" className={styles.settingsLink}>
              <Settings className="w-4 h-4" />
            </Link>
          </div>

          <button type="button" onClick={onLogout} className={styles.logoutButton}>
            <LogOut className="w-4 h-4" />
            <span>Terminate Session</span>
          </button>
        </div>
      </motion.aside>

      {/* ── Main area ─── */}
      <main className={styles.mainArea}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerBtnGroup}>
            <button
              type="button"
              onClick={() => setIsSidebarOpen(v => !v)}
              aria-label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
              aria-expanded={isSidebarOpen}
              className={styles.headerBtn}
            >
              {isSidebarOpen
                ? <PanelLeftClose className="w-5 h-5" />
                : <PanelLeftOpen className="w-5 h-5" />}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className={styles.headerBtn}
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>

          <div className={styles.statusGroup}>
            <div className={styles.statusText}>
              <span>Powered by Claude Opus 4.6</span>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div
          className={`${styles.messagesArea} custom-scrollbar`}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          <div className={styles.messagesInner}>
            {messages.map(msg => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={styles.messageRow}
                aria-label={msg.role === 'assistant' ? 'Neo Agent message' : 'Your message'}
              >
                {msg.role === 'assistant' && (
                  <div className={styles.msgAvatarAssistant}>
                    <Image src="/neo-icon.png" alt="" width={32} height={32} className="rounded" />
                  </div>
                )}
                {msg.role === 'user' && (
                  <div className={styles.msgAvatarUser}>
                    <UserAvatar src={userImage} userName={userName} size={32} decorative />
                  </div>
                )}

                <div className={msg.role === 'user' ? styles.msgContentUser : styles.msgContent}>
                  <div className={styles.msgLabel}>
                    {msg.role === 'assistant' ? 'Neo Agent' : userName}
                  </div>
                  <div
                    className={
                      msg.role === 'assistant'
                        ? styles.msgBubbleAssistant
                        : styles.msgBubbleUser
                    }
                  >
                    {msg.skillBadge
                      ? <span role="status" className={styles.skillBadge}>Skill: {msg.skillBadge}</span>
                      : msg.role === 'assistant'
                      ? <MarkdownRenderer content={msg.content} />
                      : msg.content}
                    {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                      <div className={styles.toolSummary}>
                        <div id={`tools-label-${msg.id}`} className={styles.toolSummaryLabel}>Tools used:</div>
                        <ul role="list" aria-labelledby={`tools-label-${msg.id}`} className={styles.toolSummaryList}>
                          {msg.toolsUsed.map((tool, i) => (
                            <li key={`${i}-${tool}`} className={styles.toolSummaryItem}>
                              <span aria-hidden="true" className={styles.toolSummaryBullet}>&bull;</span>
                              <span className={styles.toolSummaryItemName}>{tool}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}

            {/* Persistent live region for screen readers — always mounted, never animated */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {isThinking
                ? 'Neo is thinking'
                : currentToolName
                  ? `Running ${currentToolName}`
                  : ''}
            </div>

            <AnimatePresence>
              {(isThinking || currentToolName) && (
                <motion.div
                  key="loading-indicator"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  className={styles.messageRow}
                  aria-hidden="true"
                >
                  <div className={styles.msgAvatarAssistant}>
                    <Image src="/neo-icon.png" alt="" width={32} height={32} className="rounded" />
                  </div>
                  <div className={styles.msgContent}>
                    <div className={styles.msgLabel}>Neo Agent</div>
                    {currentToolName ? (
                      <div className={styles.thinkingIndicator}>
                        <Loader2 className={styles.spinner} aria-hidden="true" />
                        <span>Running {currentToolName}...</span>
                      </div>
                    ) : (
                      <ThinkingBubble />
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>
        </div>

        {pendingConfirmation && (
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={`Confirm action: ${pendingConfirmation.name}`}
            aria-describedby="confirm-action-desc"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={styles.confirmationBar}
          >
            <span id="confirm-action-desc">Confirm action: {pendingConfirmation.name}?</span>
            <div className={styles.confirmationBtns}>
              <button
                ref={confirmBtnRef}
                type="button"
                className={styles.confirmBtn}
                onClick={() => { void handleConfirmAction(true) }}
              >
                Confirm
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => { void handleConfirmAction(false) }}
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}

        {/* Input */}
        <div className={styles.inputArea}>
          <div className={styles.inputInner}>
            <div className={styles.inputGroup}>
              <div className={styles.inputGlow} />
              {/* Slash command popover */}
              {slashMenuOpen && (
                <ul id="slash-listbox" role="listbox" aria-label="Available skills" className={styles.slashPopover}>
                  {filteredSkills.length === 0 ? (
                    <li role="option" aria-disabled="true" aria-selected="false" className={styles.slashEmpty}>
                      No skills available
                    </li>
                  ) : (
                    filteredSkills.map((skill, i) => (
                      <li
                        key={skill.id}
                        id={`slash-option-${i}`}
                        role="option"
                        aria-selected={i === slashSelectedIndex}
                        className={`${styles.slashItem} ${i === slashSelectedIndex ? styles.slashItemActive : ''}`}
                        onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(skill) }}
                      >
                        <span className={styles.slashItemName}>/{skill.id}</span>
                        <span className={styles.slashItemDescription}>{skill.name}</span>
                        {skill.parameters.length > 0 && (
                          <span className={styles.slashItemParams}>
                            {skill.parameters.map((p) => `<${p}>`).join(' ')}
                          </span>
                        )}
                      </li>
                    ))
                  )}
                </ul>
              )}
              <div className={styles.inputContainer}>
                <label htmlFor="chat-input" className="sr-only">Security directive</label>
                <textarea
                  ref={textareaRef}
                  id="chat-input"
                  role="combobox"
                  aria-expanded={slashMenuOpen}
                  aria-haspopup="listbox"
                  aria-controls={slashMenuOpen ? 'slash-listbox' : undefined}
                  aria-activedescendant={slashMenuOpen && filteredSkills.length > 0 ? `slash-option-${slashSelectedIndex}` : undefined}
                  value={inputValue}
                  onChange={e => handleSlashInputChange(e.target.value)}
                  onKeyDown={e => {
                    if (slashMenuOpen) {
                      handleSlashKeyDown(e)
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSendMessage()
                    }
                  }}
                  placeholder={messages.length > 1 ? 'Reply...' : 'Enter security directive...'}
                  disabled={isLoading}
                  className={styles.textarea}
                />
                <div className={styles.inputActions}>
                  {userRole?.toLowerCase() === 'admin' && (
                    <Link
                      href="/integrations"
                      className={styles.plusBtn}
                      aria-label="Integrations"
                    >
                      <Plus className="w-5 h-5" />
                    </Link>
                  )}
                  <div className={styles.inputActionsSpacer} />
                  <button
                    type="button"
                    onClick={() => { void handleSendMessage() }}
                    disabled={!inputValue.trim() || isLoading}
                    aria-label="Send message"
                    className={styles.sendBtn}
                  >
                    <ArrowUp className="w-5 h-5" />
                  </button>
                </div>
              </div>

            </div>

          </div>
          <div className={styles.inputFooter}>
            <p className={styles.inputFooterText}>
              Neo is an AI and can make mistakes. Please double-check responses.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
