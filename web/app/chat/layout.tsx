import { redirect } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { ChatLayoutClient } from './ChatLayoutClient'
import type { ConversationMeta } from '@/lib/types'

// modelDisplayName used to compute a static "Powered by …" label
// for the chat header at layout render time. That responsibility now
// lives inside <ChatInterface>, which derives the label from the
// reactive `contextTier` state via `displayNameForTier(tier)`. So the
// label flips immediately when the user toggles Sonnet ↔ Opus and
// shows the locked model on conversation resume — neither of which
// the server-rendered prop could do. See the migration plan.

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

  const { userName, userRole, ownerId, userImage } = authCtx
  const initialConversations = ownerId ? await fetchConversations(ownerId) : []

  return (
    <ChatLayoutClient
      userName={userName}
      userRole={userRole}
      userImage={userImage}
      initialConversations={initialConversations}
    >
      {children}
    </ChatLayoutClient>
  )
}
