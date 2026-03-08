'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { motion } from 'motion/react'
import {
  User,
  Plus,
  MessageSquare,
  Settings,
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
import { useTheme } from '@/context/ThemeContext'
import styles from './ChatInterface.module.css'
import type { ConversationMeta, PendingTool } from '@/lib/types'

// ─────────────────────────────────────────────────────────────
//  Types for NDJSON stream events and content blocks
// ─────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface SessionEvent { type: 'session'; sessionId: string }
interface ThinkingEvent { type: 'thinking' }
interface ToolCallEvent { type: 'tool_call'; tool: string; input: Record<string, unknown> }
interface ConfirmationEvent { type: 'confirmation_required'; tool: PendingTool }
interface ResponseEvent { type: 'response'; text: string }
interface ErrorEvent { type: 'error'; message: string; code?: string }

type StreamEvent =
  | SessionEvent
  | ThinkingEvent
  | ToolCallEvent
  | ConfirmationEvent
  | ResponseEvent
  | ErrorEvent

interface TextBlock { type: 'text'; text: string }

function isTextBlock(b: unknown): b is TextBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as TextBlock).type === 'text' &&
    typeof (b as TextBlock).text === 'string'
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
  initialConversations?: ConversationMeta[]
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

export function ChatInterface({
  onLogout,
  userName = 'Operator',
  userRole = 'Reader',
  initialConversations = [],
  className,
}: ChatInterfaceProps) {
  const { theme, toggleTheme } = useTheme()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES)
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activeConversationId, _setActiveConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>(initialConversations)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTitleValue, setEditingTitleValue] = useState('')
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingTool | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const isDark = theme === 'dark'

  // Ref to keep activeConversationId current inside async closures
  const activeConversationIdRef = useRef<string | null>(null)
  const setActiveConversationId = (id: string | null) => {
    activeConversationIdRef.current = id
    _setActiveConversationId(id)
  }

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
      const res = await fetch('/api/conversations')
      if (res.ok) {
        const data = await res.json()
        setConversations(data.conversations ?? [])
      }
    } catch (err) {
      console.error('[refreshConversations]', err)
    }
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`)
      if (!res.ok) {
        console.error('[loadConversation] Server returned', res.status)
        return
      }

      const conv = await res.json()
      setActiveConversationId(id)
      setPendingConfirmation(conv.pendingConfirmation ?? null)

      // Convert Anthropic messages to ChatMessage format
      const chatMessages: ChatMessage[] = []
      for (const msg of conv.messages ?? []) {
        if (msg.role === 'user' || msg.role === 'assistant') {
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

      setMessages(chatMessages.length > 0 ? chatMessages : INITIAL_MESSAGES)
    } catch (err) {
      console.error('[loadConversation]', err)
    }
  }, [])

  const handleNewConversation = () => {
    setActiveConversationId(null)
    setMessages(INITIAL_MESSAGES)
    setPendingConfirmation(null)
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
      void refreshConversations()
    }
  }

  const processNDJSONStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buffer = ''

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
              }
              break
            case 'thinking':
              break
            case 'tool_call':
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `Running tool: ${event.tool}`,
                },
              ])
              break
            case 'confirmation_required':
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
              setMessages(prev => [
                ...prev,
                { id: crypto.randomUUID(), role: 'assistant', content: event.text },
              ])
              break
            case 'error':
              setMessages(prev => [
                ...prev,
                { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${event.message}` },
              ])
              break
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  }

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return

    const userMessage = inputValue
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
      void refreshConversations()
    }
  }

  return (
    <div className={`${styles.container} ${className ?? ''}`}>
      {/* ── Sidebar ─── */}
      <motion.aside
        initial={false}
        animate={{ width: isSidebarOpen ? 280 : 0, opacity: isSidebarOpen ? 1 : 0 }}
        className={styles.sidebar}
        aria-label="Navigation sidebar"
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
            <div className={styles.avatar}>
              <User className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className={styles.userInfo}>
              <div className={styles.userName}>{userName}</div>
              <div className={styles.clearance}>
                {userRole}
              </div>
            </div>
            <Settings className="w-4 h-4" aria-hidden="true" />
          </div>

          <button onClick={onLogout} className={styles.logoutButton}>
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
              onClick={() => setIsSidebarOpen(v => !v)}
              aria-label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
              className={styles.headerBtn}
            >
              {isSidebarOpen
                ? <PanelLeftClose className="w-5 h-5" />
                : <PanelLeftOpen className="w-5 h-5" />}
            </button>
            <button
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

                <div className={msg.role === 'user' ? styles.msgContentUser : styles.msgContent}>
                  {msg.role === 'assistant' && (
                    <div className={styles.msgLabel}>
                      Neo Agent
                    </div>
                  )}
                  <div
                    className={
                      msg.role === 'assistant'
                        ? styles.msgBubbleAssistant
                        : styles.msgBubbleUser
                    }
                  >
                    {msg.content}
                  </div>
                </div>
              </motion.div>
            ))}

            {isLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={styles.messageRow}
                role="status"
                aria-live="polite"
              >
                <div className={styles.msgAvatarAssistant}>
                  <Image src="/neo-icon.png" alt="" width={32} height={32} className="rounded" />
                </div>
                <div className={styles.msgContent}>
                  <div className={styles.msgLabel}>Neo Agent</div>
                  <div className={styles.thinkingIndicator}>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Processing...</span>
                  </div>
                </div>
              </motion.div>
            )}

            {pendingConfirmation && (
              <motion.div
                role="alertdialog"
                aria-live="assertive"
                aria-label={`Confirm action: ${pendingConfirmation.name}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={styles.confirmationBar}
              >
                <span>Confirm action: {pendingConfirmation.name}?</span>
                <div className={styles.confirmationBtns}>
                  <button
                    ref={confirmBtnRef}
                    className={styles.confirmBtn}
                    onClick={() => { void handleConfirmAction(true) }}
                  >
                    Confirm
                  </button>
                  <button
                    className={styles.cancelBtn}
                    onClick={() => { void handleConfirmAction(false) }}
                  >
                    Cancel
                  </button>
                </div>
              </motion.div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className={styles.inputArea}>
          <div className={styles.inputInner}>
            <div className={styles.inputGroup}>
              <div className={styles.inputGlow} />
              <div className={styles.inputContainer}>
                <label htmlFor="chat-input" className="sr-only">Security directive</label>
                <textarea
                  ref={textareaRef}
                  id="chat-input"
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={e => {
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
