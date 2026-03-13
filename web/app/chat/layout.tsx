import { redirect } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { ChatLayoutClient } from './ChatLayoutClient'
import type { ConversationMeta } from '@/lib/types'

async function fetchConversations(ownerId: string): Promise<ConversationMeta[]> {
  try {
    const { env } = await import('@/lib/config')
    if (!env.COSMOS_ENDPOINT || env.MOCK_MODE) return []

    const { listConversations } = await import('@/lib/conversation-store')
    return await listConversations(ownerId, 'web')
  } catch {
    return []
  }
}

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const authCtx = await getAuthContext()
  if (!authCtx) {
    redirect('/')
  }

  const { userName, userRole, ownerId } = authCtx
  const initialConversations = ownerId ? await fetchConversations(ownerId) : []

  return (
    <ChatLayoutClient
      userName={userName}
      userRole={userRole}
      initialConversations={initialConversations}
    >
      {children}
    </ChatLayoutClient>
  )
}
