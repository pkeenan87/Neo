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
  Paperclip,
  Square,
  MessageSquareDashed,
} from 'lucide-react'
import Link from 'next/link'
import { useTheme } from '@/context/ThemeContext'
import { useConversationCache } from '@/context/ConversationCacheContext'
import { useToast } from '@/context/ToastContext'
import { MarkdownRenderer, MessageActions, ThinkingBubble, UserAvatar, FileAttachmentBar } from '@/components'
import { useFileUpload } from '@/hooks/useFileUpload'
import styles from './ChatInterface.module.css'
import type { Conversation, ConversationMeta, PendingTool, ToolTrace } from '@/lib/types'
import { extractTextAttachments, formatAttachmentSize, type ChatAttachment } from '@/lib/chat-attachments'

// ─────────────────────────────────────────────────────────────
//  Types for NDJSON stream events and content blocks
// ─────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolsUsed?: string[]
  /**
   * Full per-tool trace (input + output + optional durationMs). Populated
   * during live streaming from `tool_result` events and reconstructed on
   * reload from the persisted tool_use / tool_result blocks. When present,
   * the UI renders expandable accordions in place of the legacy name-only
   * bullet list.
   */
  toolTraces?: ToolTrace[]
  skillBadge?: string
  interrupted?: boolean
  /**
   * The assistant turn hit the model's max_tokens ceiling — rendered
   * partial. The ChatInterface shows a "Truncated" badge and a warning
   * toast. Reload hydration sets this from the `[truncated]` suffix on
   * the persisted message content (stripped before render).
   */
  truncated?: boolean
  attachments?: ChatAttachment[]
}

interface SessionEvent { type: 'session'; sessionId: string }
interface ThinkingEvent { type: 'thinking' }
interface ToolCallEvent { type: 'tool_call'; tool: string; input: Record<string, unknown> }
interface ToolResultEvent { type: 'tool_result'; tool: string; input: Record<string, unknown>; output: unknown; durationMs: number; isError?: boolean }
interface ConfirmationEvent { type: 'confirmation_required'; tool: PendingTool }
interface ResponseEvent { type: 'response'; text: string; interrupted?: boolean; truncated?: boolean }
interface ErrorEvent { type: 'error'; message: string; code?: string }
interface SkillInvocationEvent { type: 'skill_invocation'; skill: { id: string; name: string } }
interface InterruptedEvent { type: 'interrupted' }
interface ContextTrimmedEvent { type: 'context_trimmed'; originalTokens: number; newTokens: number; method: 'truncation' | 'summary' }
interface OutputTruncatedPlan { planText: string; toolCallsRemaining: number }
interface OutputTruncatedEvent {
  type: 'output_truncated'
  phase: 'tool_use' | 'text'
  message: string
  remainingPlan: OutputTruncatedPlan | null
}

type StreamEvent =
  | SessionEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ConfirmationEvent
  | ResponseEvent
  | ErrorEvent
  | SkillInvocationEvent
  | InterruptedEvent
  | ContextTrimmedEvent
  | OutputTruncatedEvent

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

// Pull tool_use blocks out of an assistant message (returns [] if the
// content shape doesn't carry any — e.g. a plain string response).
// Defensively skips blocks missing id/name so a malformed persisted
// message produces no trace rather than a ghost accordion with
// undefined in the header.
function extractToolUseBlocks(
  content: unknown,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type: string }).type === 'tool_use'
    ) {
      const b = block as { id?: unknown; name?: unknown; input?: unknown }
      if (typeof b.id !== 'string' || typeof b.name !== 'string') continue
      const input =
        typeof b.input === 'object' && b.input !== null
          ? (b.input as Record<string, unknown>)
          : {}
      out.push({ id: b.id, name: b.name, input })
    }
  }
  return out
}

// Pull tool_result blocks out of a user message (the carrier the API uses
// to ship tool outputs back to the next turn). Same defensive skip as
// above when tool_use_id is missing.
function extractToolResultBlocks(
  content: unknown,
): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type: string }).type === 'tool_result'
    ) {
      const b = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown }
      if (typeof b.tool_use_id !== 'string') continue
      out.push({
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error === true,
      })
    }
  }
  return out
}

// A user message that is ONLY tool_result blocks (not real user text) —
// these are plumbing messages from the API and aren't shown in the UI.
function isToolResultsMessage(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(
    (b: unknown) =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type: string }).type === 'tool_result',
  )
}

// Human-friendly wall-clock duration for the tool-trace summary row.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(2)}s` : `${Math.round(s)}s`
}

// Per-trace output character cap for the UI. 100K chars covers essentially
// all realistic tool outputs while preventing a runaway KQL response from
// pushing component state into multi-MB territory. Orthogonal to the
// server-side 50K-token cap in context-manager.ts which bounds what goes
// back to the model; this one only bounds what we render.
const TRACE_CHAR_CAP = 100_000

// Cheap check: does a string look like JSON? We only try to JSON.parse
// when the first non-whitespace char is plausibly the start of a JSON
// token. Prevents safeStringify from double-parsing plain-text outputs
// (e.g. "3.14159e+2" → "314.159") that happen to be JSON-parseable.
function looksLikeJson(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
    return (
      c === '{' ||
      c === '[' ||
      c === '"' ||
      c === '-' ||
      (c >= '0' && c <= '9') ||
      c === 't' ||
      c === 'f' ||
      c === 'n'
    )
  }
  return false
}

// JSON-ify a tool-trace value for display. Handles: pre-stringified JSON
// (pretty-prints it), plain strings (passes through), plain objects
// (pretty-prints). Caps the result to TRACE_CHAR_CAP so one huge payload
// can't blow up client memory.
function safeStringify(value: unknown): string {
  let out: string
  if (typeof value === 'string') {
    if (looksLikeJson(value)) {
      try {
        const parsed: unknown = JSON.parse(value)
        out = JSON.stringify(parsed, null, 2)
      } catch {
        out = value
      }
    } else {
      out = value
    }
  } else {
    try {
      out = JSON.stringify(value, null, 2)
    } catch {
      out = String(value)
    }
  }
  if (out.length > TRACE_CHAR_CAP) {
    return (
      out.slice(0, TRACE_CHAR_CAP) +
      `\n\n… (output truncated — ${out.length - TRACE_CHAR_CAP} chars omitted)`
    )
  }
  return out
}

// Scroll the tail-anchor element into view. Honors `prefers-reduced-motion`
// — users who opt out of motion at the OS level get an instant jump rather
// than a smooth animation. Shared by both the messages-change scroll and
// the indicator-first-mount scroll so there's one source of truth for the
// scroll behavior.
function scrollToEnd(anchor: HTMLElement | null) {
  if (!anchor) return
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  anchor.scrollIntoView({ behavior: prefersReducedMotion ? 'instant' : 'smooth' })
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
  defaultModelName?: string
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

const SKILL_INVOCATION_RE = /^\[SKILL INVOCATION: (.+?)\]\n\n[\s\S]*\n\n---\n\nUser input: ([\s\S]*)$/
const INTERRUPTED_SUFFIX_RE = /\s*\[interrupted\]\s*$/
const TRUNCATED_SUFFIX_RE = /\s*\[truncated\]\s*$/

function conversationToChatMessages(conv: Conversation): ChatMessage[] {
  const chatMessages: ChatMessage[] = []
  // Reconstruct tool traces on reload by pairing persisted tool_use blocks
  // (from intermediate assistant turns) with their tool_result carriers
  // (the plumbing user messages). Traces accumulated within a turn are
  // attached to the FINAL text assistant message of that turn, then the
  // accumulator resets when the next real user text message arrives.
  const pendingToolUse = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >()
  let pendingTraces: ToolTrace[] = []

  for (const msg of conv.messages ?? []) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      // User-side plumbing: a message that's purely tool_result blocks
      // carries tool outputs back to the next turn. Pair them with
      // previously-seen tool_use blocks and drop the message — it's not
      // a visible user turn.
      if (msg.role === 'user' && isToolResultsMessage(msg.content)) {
        for (const r of extractToolResultBlocks(msg.content)) {
          const tu = pendingToolUse.get(r.tool_use_id)
          if (tu) {
            pendingTraces.push({
              name: tu.name,
              input: tu.input,
              output: r.content,
              isError: r.is_error === true,
            })
            pendingToolUse.delete(r.tool_use_id)
          }
        }
        continue
      }

      // A real user text message → new turn. Reset the trace accumulator
      // so traces from the prior answer don't leak forward.
      if (msg.role === 'user') {
        pendingTraces = []
        pendingToolUse.clear()
      }

      // Record any tool_use blocks on this assistant turn so we can pair
      // them with the tool_result that follows.
      if (msg.role === 'assistant') {
        for (const tu of extractToolUseBlocks(msg.content)) {
          pendingToolUse.set(tu.id, { name: tu.name, input: tu.input })
        }
      }

      // Skip intermediate assistant turns (tool-use reasoning / thinking)
      // so reload matches the live streaming experience where only the
      // final response is shown.
      if (msg.role === 'assistant' && isIntermediateAssistantTurn(msg.content)) {
        continue
      }
      let content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(isTextBlock).map((b: TextBlock) => b.text).join('\n')
          : ''

      // Extract any text-family file attachments (.txt/.json/.log/.md
      // wrapped in <text_attachment> blocks by lib/txt-content-blocks.ts).
      // We render these as badges above the markdown body instead of
      // letting the file body show up inline in the conversation.
      // NOTE: `attachments` is forwarded into BOTH the skill-rewrite
      // branch AND the regular branch below, so a skill-invocation
      // message that also has an attachment keeps both behaviors.
      const extracted = extractTextAttachments(content)
      content = extracted.text
      const attachments = extracted.attachments

      // Detect expanded skill invocation messages and replace with the
      // original user input so reload matches the live experience.
      // The full skill instructions are internal — only the user's
      // slash command and args should be visible.
      if (msg.role === 'user' && content) {
        const skillMatch = SKILL_INVOCATION_RE.exec(content)
        if (skillMatch) {
          const skillName = skillMatch[1]
          const rawUserInput = skillMatch[2].trim()
          const userInput = rawUserInput === '(no additional input)' ? '' : rawUserInput
          // 1. Push the user's original input (slash command or raw args)
          chatMessages.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: userInput || `/${skillName.toLowerCase().replace(/\s+/g, '-')}`,
            ...(attachments.length > 0 && { attachments }),
          })
          // 2. Push the skill badge as a synthetic assistant message (mirrors live stream)
          chatMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            skillBadge: skillName,
          })
          continue
        }
      }

      // Detect interrupted marker at the end of assistant messages.
      // Use a strict end-anchored regex for both detection and stripping so
      // legitimate responses that happen to contain "[interrupted]" elsewhere
      // are not falsely flagged.
      let isInterrupted = false
      if (msg.role === 'assistant' && INTERRUPTED_SUFFIX_RE.test(content)) {
        isInterrupted = true
        content = content.replace(INTERRUPTED_SUFFIX_RE, '').trim()
      }

      // Same pattern for the truncated marker — the agent loop appends
      // `[truncated]` to the persisted assistant content when it hit
      // max_tokens, and reload reads that back as the `truncated: true`
      // flag on the rendered ChatMessage.
      let isTruncated = false
      if (msg.role === 'assistant' && TRUNCATED_SUFFIX_RE.test(content)) {
        isTruncated = true
        content = content.replace(TRUNCATED_SUFFIX_RE, '').trim()
      }

      if (content || isInterrupted || isTruncated || attachments.length > 0) {
        const attachTraces =
          msg.role === 'assistant' && pendingTraces.length > 0
        chatMessages.push({
          id: crypto.randomUUID(),
          role: msg.role,
          content,
          ...(isInterrupted && { interrupted: true }),
          ...(isTruncated && { truncated: true }),
          ...(attachments.length > 0 && { attachments }),
          ...(attachTraces && { toolTraces: [...pendingTraces] }),
        })
        // Reset after attaching so the next turn starts clean.
        if (attachTraces) {
          pendingTraces = []
          pendingToolUse.clear()
        }
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
  defaultModelName = 'Claude Sonnet',
  className,
}: ChatInterfaceProps) {
  const { theme, toggleTheme } = useTheme()
  const cache = useConversationCache()
  const { toast } = useToast()
  // Sidebar starts open. The initial state MUST match SSR output to avoid
  // a React hydration mismatch — so we always render `true` on first paint
  // and correct to the real media-query result in a one-shot effect on
  // mount. On mobile this means a single frame with the sidebar visible
  // before it collapses; the alternative (reading matchMedia in the
  // initializer) produces a hydration warning since SSR has no `window`.
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true)

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)')
    setIsSidebarOpen(!mql.matches)
    const onChange = (e: MediaQueryListEvent) => {
      // Only force-collapse on transition INTO mobile. Leaving mobile
      // (rotating to landscape / resizing wider) preserves whatever the
      // user has set so we don't fight their explicit choice.
      if (e.matches) setIsSidebarOpen(false)
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (initialConversation) {
      const loaded = conversationToChatMessages(initialConversation)
      return loaded.length > 0 ? loaded : INITIAL_MESSAGES
    }
    return INITIAL_MESSAGES
  })
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const fileUpload = useFileUpload()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const stopBtnRef = useRef<HTMLButtonElement>(null)
  const [interruptedAnnouncement, setInterruptedAnnouncement] = useState('')
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
  // Tracks whether the thinking/tool indicator was visible on the previous
  // render, so we can detect its *initial* mount and scroll it into view
  // only on that transition — not on every tool_call swap mid-stream,
  // which otherwise keeps macOS overlay scrollbars visible.
  const prevIndicatorVisibleRef = useRef(false)
  // How many consecutive truncated responses we've seen this session. After
  // 3, the toast copy escalates from "ask to continue" to "too complex".
  // Resets on any non-truncated response event.
  const consecutiveTruncationsRef = useRef(0)
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
    scrollToEnd(messagesEndRef.current)
  }, [messages])

  useEffect(() => {
    // The AnimatePresence thinking/tool indicator appears after the last
    // message. The messages-change scroll above fires BEFORE the indicator
    // mounts, so the indicator can end up below the viewport. Scroll the
    // tail anchor (messagesEndRef) into view on the first appearance only
    // — rapid tool_call swaps mid-stream should not re-scroll, since
    // continuous scroll activity keeps overlay scrollbars visible.
    const indicatorVisible = isThinking || currentToolName !== null
    if (indicatorVisible && !prevIndicatorVisibleRef.current) {
      scrollToEnd(messagesEndRef.current)
    }
    prevIndicatorVisibleRef.current = indicatorVisible
    // Reset on unmount so React StrictMode's mount → unmount → remount
    // cycle starts the gate from a clean `false` rather than letting the
    // ref-reinitialization make the first indicator mount scroll twice.
    return () => {
      prevIndicatorVisibleRef.current = false
    }
  }, [isThinking, currentToolName])

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

  // Preserve focus across the send ↔ stop button swap
  useEffect(() => {
    if (isLoading) {
      stopBtnRef.current?.focus()
    } else {
      // Return focus to the textarea so the user can type immediately
      textareaRef.current?.focus()
    }
  }, [isLoading])

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
    const toolTraces: ToolTrace[] = []

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
            case 'tool_result':
              // Cap at MAX_TOOLS to mirror the toolsUsed cap and bound
              // memory growth on exceptionally long agent turns.
              if (toolTraces.length < MAX_TOOLS) {
                toolTraces.push({
                  name: event.tool,
                  input: event.input,
                  output: event.output,
                  durationMs: event.durationMs,
                  isError: event.isError,
                })
              }
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
                  toolTraces: toolTraces.length > 0 ? [...toolTraces] : undefined,
                  interrupted: event.interrupted,
                  truncated: event.truncated,
                },
              ])
              if (event.truncated) {
                // Track consecutive truncations. After 3, escalate the toast
                // copy — a runaway series implies the conversation's too
                // complex to complete even at the higher skill budget.
                consecutiveTruncationsRef.current += 1
                if (consecutiveTruncationsRef.current >= 3) {
                  toast({
                    intent: 'warning',
                    title: 'Response keeps getting truncated',
                    description:
                      'This conversation may be too complex to complete in one response. Consider starting a new session or narrowing the request.',
                  })
                } else {
                  toast({
                    intent: 'warning',
                    title: 'Response was truncated',
                    description:
                      'Ask Neo to continue for the rest of the response.',
                  })
                }
              } else {
                consecutiveTruncationsRef.current = 0
              }
              break
            case 'interrupted':
              setIsThinking(false)
              setMessages(prev => {
                if (prev.length === 0) return prev
                const last = prev[prev.length - 1]
                if (last.role !== 'assistant') {
                  return [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '', interrupted: true }]
                }
                return prev.map((m, i) => (i === prev.length - 1 ? { ...m, interrupted: true } : m))
              })
              setInterruptedAnnouncement('Response interrupted.')
              setTimeout(() => setInterruptedAnnouncement(''), 1000)
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
            case 'context_trimmed': {
              // Passive status — Neo compressed earlier context to stay
              // within the per-turn input-token budget. No action
              // required from the user.
              const delta = event.originalTokens - event.newTokens
              if (delta > 1000) {
                setMessages(prev => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: `_Context was compressed to fit the per-turn budget (${event.originalTokens.toLocaleString()} → ${event.newTokens.toLocaleString()} tokens)._`,
                  },
                ])
              }
              break
            }
            case 'output_truncated': {
              // Actionable — the agent's per-turn OUTPUT budget was
              // exhausted. Show the remaining plan (if any) and hint
              // that the next message will resume the workflow.
              setIsThinking(false)
              // Wrap planText in a fenced code block so any adversarial
              // Markdown that landed in the persisted plan (headers,
              // links, blockquotes) renders as preformatted text rather
              // than formatting directives. See security review S8.
              const planPreview = event.remainingPlan
                ? `\n\n**Remaining plan** (${event.remainingPlan.toolCallsRemaining} step${event.remainingPlan.toolCallsRemaining === 1 ? '' : 's'} left):\n\n\`\`\`\n${event.remainingPlan.planText}\n\`\`\``
                : ''
              setMessages(prev => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `${event.message}${planPreview}`,
                  toolsUsed: toolsUsed.length > 0 ? [...toolsUsed] : undefined,
                },
              ])
              break
            }
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

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
    // Don't null the ref here — let the finally block own cleanup so the
    // catch block can distinguish user-initiated aborts from other aborts.
    // Optimistically flip isLoading so the button immediately swaps back
    // and can't be double-clicked while the async settle runs.
    setIsLoading(false)
    setInterruptedAnnouncement('Response interrupted.')
    setTimeout(() => setInterruptedAnnouncement(''), 1000)
  }, [])

  const handleSendMessage = async (messageOverride?: string) => {
    const msg = messageOverride ?? inputValue
    if ((!msg.trim() && !fileUpload.hasFiles) || isLoading) return

    const userMessage = msg
    setInputValue('')
    const currentFiles = [...fileUpload.files]
    fileUpload.clearFiles()
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMessage }])
    setIsLoading(true)

    // Create a new AbortController for this request
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      let res: Response
      if (currentFiles.length > 0) {
        // Multipart upload when files are attached
        const formData = new FormData()
        formData.append('message', userMessage)
        if (activeConversationIdRef.current) {
          formData.append('sessionId', activeConversationIdRef.current)
        }
        for (const cf of currentFiles) {
          formData.append('files', cf.file)
        }
        res = await fetch('/api/agent', { method: 'POST', body: formData, signal: controller.signal })
      } else {
        // JSON for text-only messages
        res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: activeConversationIdRef.current,
            message: userMessage,
          }),
          signal: controller.signal,
        })
      }

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
      // AbortError from stop button. Additionally check that the ref was
      // cleared by handleStop — if the abort is from navigation/unload rather
      // than a user click, abortControllerRef.current will still be set to
      // the controller instance (not null), so we treat it as a connection
      // error instead of a deliberate interrupt.
      const isUserAbort =
        (err as Error).name === 'AbortError' &&
        abortControllerRef.current?.signal.aborted === true
      if (isUserAbort) {
        setMessages(prev => {
          if (prev.length === 0) return prev
          const last = prev[prev.length - 1]
          if (last.role !== 'assistant') {
            return [...prev, { id: crypto.randomUUID(), role: 'assistant', content: '', interrupted: true }]
          }
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, interrupted: true } : m))
        })
        return
      }
      console.error('[handleSendMessage]', err)
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Connection error. Please try again.' },
      ])
    } finally {
      abortControllerRef.current = null
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
          <Link href="/chat" className={styles.sidebarBrandRow}>
            <Image src="/neo-icon.png" alt="" width={20} height={20} className="rounded shrink-0" />
            <span className={styles.sidebarBrand}>NEO</span>
          </Link>
        </div>

        {/* Sidebar body */}
        <div className={`${styles.sidebarBody} custom-scrollbar`}>
          <button className={styles.newOpBtn} onClick={handleNewConversation}>
            <Plus className="w-4 h-4" />
            <span>New Operation</span>
          </button>

          <nav aria-label="Recent conversations">
            <div className={styles.sectionLabel}>
              Recent Conversations
            </div>
            {conversations.length === 0 && (
              <div className={styles.emptyState}>
                <MessageSquareDashed
                  className={styles.emptyStateIcon}
                  aria-hidden="true"
                />
                <span>No conversations yet</span>
              </div>
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
                    {/* Source order is icon → title → timestamp → actions so
                        the screen-reader reading order matches the visible
                        grouping (title + its timestamp, then the row's
                        actions). Grid placement in CSS makes the visual
                        order independent of DOM order. */}
                    <MessageSquare
                      className={styles.conversationIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.conversationTitle}>
                      {conv.title || 'New conversation'}
                    </span>
                    <span className={styles.conversationTimestamp}>
                      {relativeTime(conv.updatedAt)}
                    </span>
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
              <span>Powered by {defaultModelName}</span>
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
            {messages.map((msg, idx) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={styles.messageRow}
                aria-label={msg.skillBadge ? `Skill invoked: ${msg.skillBadge}` : msg.role === 'assistant' ? 'Neo Agent message' : 'Your message'}
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
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className={styles.attachmentBadgeRow} role="list" aria-label="Attached files">
                        {msg.attachments.map((att) => {
                          const sizeHint = formatAttachmentSize(att.sizeBytes)
                          return (
                            <span
                              key={`${att.filename}-${att.sizeBytes}`}
                              role="listitem"
                              className={styles.attachmentBadge}
                            >
                              <span aria-hidden="true">📎</span>
                              <span className={styles.attachmentBadgeName}>{att.filename}</span>
                              {sizeHint && (
                                <span className={styles.attachmentBadgeSize}>{sizeHint}</span>
                              )}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {msg.skillBadge
                      ? <span className={styles.skillBadge}>Skill: {msg.skillBadge}</span>
                      : msg.role === 'assistant'
                      ? msg.content && <MarkdownRenderer content={msg.content} />
                      : msg.content}
                    {msg.interrupted && (
                      <span className={styles.interruptedBadge}>Interrupted</span>
                    )}
                    {msg.truncated && (
                      // role="status" turns this into an implicit polite
                      // live region. Inert on the reload / hydration path
                      // (live regions don't fire for initial paint), but
                      // any future code that flips `msg.truncated` at
                      // runtime would be announced correctly.
                      <span role="status" className={styles.truncatedBadge}>
                        Truncated
                      </span>
                    )}
                    {msg.toolTraces && msg.toolTraces.length > 0 ? (
                      <div className={styles.toolSummary}>
                        <div id={`tools-label-${msg.id}`} className={styles.toolSummaryLabel}>
                          Tools used:
                        </div>
                        <ul
                          role="list"
                          aria-labelledby={`tools-label-${msg.id}`}
                          className={styles.toolTraceList}
                        >
                          {msg.toolTraces.map((trace, i) => {
                            // Compose a robust aria-label that always carries
                            // the failure state, even under AT verbosity
                            // settings that skip the badge span.
                            const summaryLabel = [
                              trace.name,
                              typeof trace.durationMs === 'number'
                                ? formatDuration(trace.durationMs)
                                : null,
                              trace.isError ? 'failed' : null,
                            ]
                              .filter(Boolean)
                              .join(', ')
                            return (
                              <li
                                key={`${i}-${trace.name}`}
                                className={styles.toolTraceItem}
                              >
                                <details className={styles.toolTrace}>
                                  <summary
                                    className={styles.toolTraceSummary}
                                    aria-label={summaryLabel}
                                  >
                                    <span className={styles.toolTraceSummaryName}>
                                      {trace.name}
                                    </span>
                                    {typeof trace.durationMs === 'number' && (
                                      <span
                                        className={styles.toolTraceDuration}
                                        aria-hidden="true"
                                      >
                                        {formatDuration(trace.durationMs)}
                                      </span>
                                    )}
                                    {trace.isError && (
                                      <span
                                        className={styles.toolTraceErrorBadge}
                                        aria-hidden="true"
                                      >
                                        error
                                      </span>
                                    )}
                                  </summary>
                                  {/* aria-live="off" scopes this subtree
                                      out of the ancestor role="log"
                                      aria-live="polite" region so expanding
                                      a trace doesn't trigger an SR deluge
                                      of the entire JSON body. */}
                                  <div
                                    className={styles.toolTraceBody}
                                    aria-live="off"
                                  >
                                    <div className={styles.toolTraceKey}>Input</div>
                                    <pre
                                      className={styles.toolTracePre}
                                      tabIndex={0}
                                      aria-label={`${trace.name} input`}
                                    >
                                      {safeStringify(trace.input)}
                                    </pre>
                                    <div className={styles.toolTraceKey}>Output</div>
                                    <pre
                                      className={styles.toolTracePre}
                                      tabIndex={0}
                                      aria-label={`${trace.name} output`}
                                    >
                                      {safeStringify(trace.output)}
                                    </pre>
                                  </div>
                                </details>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ) : msg.toolsUsed && msg.toolsUsed.length > 0 ? (
                      // Legacy path: old conversations persisted before the
                      // tool_result stream event shipped. No input/output to
                      // expand — render the name-only bullet list.
                      <div className={styles.toolSummary}>
                        <div id={`tools-label-${msg.id}`} className={styles.toolSummaryLabel}>
                          Tools used:
                        </div>
                        <ul
                          role="list"
                          aria-labelledby={`tools-label-${msg.id}`}
                          className={styles.toolSummaryList}
                        >
                          {msg.toolsUsed.map((tool, i) => (
                            <li key={`${i}-${tool}`} className={styles.toolSummaryItem}>
                              <span aria-hidden="true" className={styles.toolSummaryBullet}>&bull;</span>
                              <span className={styles.toolSummaryItemName}>{tool}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  {/* Action toolbar under completed assistant messages only.
                      Skip user messages, empty skill-badge placeholders, and
                      any assistant message that's still streaming (which is
                      always the last message while isLoading is true). */}
                  {msg.role === 'assistant' &&
                    msg.content &&
                    !msg.skillBadge &&
                    !(isLoading && idx === messages.length - 1) && (
                      <MessageActions content={msg.content} />
                    )}
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
              {interruptedAnnouncement
                ? interruptedAnnouncement
                : isThinking
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
                  onPaste={e => {
                    const items = e.clipboardData?.items
                    if (!items) return
                    const imageFiles: File[] = []
                    for (const item of Array.from(items)) {
                      if (item.type.startsWith('image/')) {
                        const file = item.getAsFile()
                        if (file) imageFiles.push(file)
                      }
                    }
                    if (imageFiles.length > 0) {
                      fileUpload.addFiles(imageFiles)
                    }
                  }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (e.dataTransfer?.files?.length) {
                      fileUpload.addFiles(e.dataTransfer.files)
                    }
                  }}
                  placeholder={messages.length > 1 ? 'Reply...' : 'Enter security directive...'}
                  disabled={isLoading}
                  className={styles.textarea}
                />
                {fileUpload.hasFiles && (
                  <FileAttachmentBar
                    files={fileUpload.files}
                    onRemove={fileUpload.removeFile}
                  />
                )}
                {fileUpload.error && (
                  <div className={styles.fileError} role="alert">
                    {fileUpload.error}
                  </div>
                )}
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
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/csv,.csv,text/plain,.txt"
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(e) => {
                      if (e.target.files) fileUpload.addFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                    aria-label="Attach file"
                    className={styles.attachBtn}
                  >
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <div className={styles.inputActionsSpacer} />
                  {isLoading ? (
                    <button
                      ref={stopBtnRef}
                      type="button"
                      onClick={handleStop}
                      aria-label="Stop response"
                      className={styles.stopBtn}
                    >
                      <Square className="w-4 h-4" fill="currentColor" />
                    </button>
                  ) : (
                    (() => {
                      const sendReady = inputValue.trim().length > 0 || fileUpload.hasFiles
                      const sendClasses = sendReady
                        ? `${styles.sendBtn} ${styles.ready}`
                        : styles.sendBtn
                      return (
                        <button
                          type="button"
                          onClick={() => { void handleSendMessage() }}
                          disabled={!sendReady}
                          aria-label="Send message"
                          className={sendClasses}
                        >
                          <ArrowUp className="w-5 h-5" />
                        </button>
                      )
                    })()
                  )}
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
