'use client'

import { ConversationCacheProvider } from '@/context/ConversationCacheContext'
import type { ConversationMeta } from '@/lib/types'
import { ChatLayoutContext } from './ChatLayoutContext'

interface ChatLayoutClientProps {
  userName: string
  userRole: string
  userImage?: string
  initialConversations: ConversationMeta[]
  defaultModelName: string
  children: React.ReactNode
}

export function ChatLayoutClient({
  userName,
  userRole,
  userImage,
  initialConversations,
  defaultModelName,
  children,
}: ChatLayoutClientProps) {
  return (
    <ConversationCacheProvider>
      <ChatLayoutContext.Provider value={{ userName, userRole, userImage, initialConversations, defaultModelName }}>
        {children}
      </ChatLayoutContext.Provider>
    </ConversationCacheProvider>
  )
}
