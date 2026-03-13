'use client'

import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { ChatInterface } from '@/components/ChatInterface'
import { useChatLayout } from './ChatLayoutContext'
import type { Conversation } from '@/lib/types'

interface ChatPageClientProps {
  initialConversation?: Conversation
}

export function ChatPageClient({ initialConversation }: ChatPageClientProps) {
  const router = useRouter()
  const { userName, userRole, userImage, initialConversations } = useChatLayout()

  const handleLogout = () => {
    if (process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === 'true') {
      router.push('/')
      return
    }
    signOut({ callbackUrl: '/' })
  }

  return (
    <ChatInterface
      onLogout={handleLogout}
      userName={userName}
      userRole={userRole}
      userImage={userImage}
      initialConversations={initialConversations}
      initialConversation={initialConversation}
    />
  )
}
