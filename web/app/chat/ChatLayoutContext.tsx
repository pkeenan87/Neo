'use client'

import { createContext, useContext } from 'react'
import type { ConversationMeta } from '@/lib/types'

interface ChatLayoutValue {
  userName: string
  userRole: string
  userImage?: string
  initialConversations: ConversationMeta[]
  defaultModelName: string
}

export const ChatLayoutContext = createContext<ChatLayoutValue>({
  userName: '',
  userRole: '',
  initialConversations: [],
  defaultModelName: 'Claude Sonnet',
})

export function useChatLayout(): ChatLayoutValue {
  return useContext(ChatLayoutContext)
}
