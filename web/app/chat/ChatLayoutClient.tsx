'use client'

import { ConversationCacheProvider } from '@/context/ConversationCacheContext'
import type { ConversationMeta } from '@/lib/types'
import { ChatLayoutContext } from './ChatLayoutContext'

interface ChatLayoutClientProps {
  userName: string
  userRole: string
  initialConversations: ConversationMeta[]
  children: React.ReactNode
}

export function ChatLayoutClient({
  userName,
  userRole,
  initialConversations,
  children,
}: ChatLayoutClientProps) {
  return (
    <ConversationCacheProvider>
      <ChatLayoutContext.Provider value={{ userName, userRole, initialConversations }}>
        {children}
      </ChatLayoutContext.Provider>
    </ConversationCacheProvider>
  )
}
