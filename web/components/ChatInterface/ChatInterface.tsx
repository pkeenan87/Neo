'use client'

import { useEffect, useRef, useState } from 'react'
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
} from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import styles from './ChatInterface.module.css'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export interface ChatInterfaceProps {
  onLogout: () => void
  userName?: string
  userRole?: string
  className?: string
}

const RECENT_LOGS = [
  'Firewall Breach Analysis',
  'Endpoint Protection Sync',
  'Anomalous Traffic Detected',
  'Kernel Exploit Mitigation',
]

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'init-1',
    role: 'assistant',
    content:
      'System initialized. I am Neo, your autonomous security operations agent. How can I assist with your perimeter defense today?',
  },
]

export function ChatInterface({ onLogout, userName = 'Operator', userRole = 'Reader', className }: ChatInterfaceProps) {
  const { theme, toggleTheme } = useTheme()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES)
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isDark = theme === 'dark'

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '3.5rem'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [inputValue])

  const handleSendMessage = () => {
    if (!inputValue.trim()) return

    const userMessage = inputValue
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMessage }])
    setInputValue('')

    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Analyzing request: "${userMessage}"... Security protocols verified. I've initiated a deep scan of the relevant network segments. No immediate threats detected, but I'm monitoring for anomalous traffic patterns.`,
        },
      ])
    }, 1000)
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
          <button className={styles.newOpBtn}>
            <Plus className="w-4 h-4" />
            <span>New Operation</span>
          </button>

          <nav aria-label="Recent logs">
            <div className={styles.sectionLabel}>
              Recent Logs
            </div>
            {RECENT_LOGS.map((log, i) => (
              <button
                key={i}
                className={styles.logItem}
              >
                <MessageSquare className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{log}</span>
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
                      handleSendMessage()
                    }
                  }}
                  placeholder={messages.length > 1 ? 'Reply...' : 'Enter security directive...'}
                  className={styles.textarea}
                />
                <div className={styles.inputActions}>
                  <button
                    type="button"
                    onClick={handleSendMessage}
                    disabled={!inputValue.trim()}
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
