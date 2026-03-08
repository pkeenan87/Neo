import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { ChatPageClient } from './ChatPageClient'
import type { ConversationMeta } from '@/lib/types'

async function fetchConversations(ownerId: string): Promise<ConversationMeta[]> {
  try {
    const { env } = await import('@/lib/config')
    if (!env.COSMOS_ENDPOINT || env.MOCK_MODE) return []

    const { listConversations } = await import('@/lib/conversation-store')
    return await listConversations(ownerId)
  } catch {
    return []
  }
}

export default async function ChatPage() {
  // In dev with DEV_AUTH_BYPASS, skip session check
  const devBypass =
    process.env.NODE_ENV === 'development' && process.env.DEV_AUTH_BYPASS === 'true'

  if (!devBypass) {
    const session = await auth()
    if (!session?.user) {
      redirect('/')
    }
  }

  // In dev bypass mode, use placeholder user data
  const session = devBypass ? null : await auth()
  const user = session?.user as Record<string, unknown> | undefined
  const userName = (user?.name as string) ?? 'Operator'
  const userRole = (user?.role as string) ?? 'admin'
  // Use immutable AAD object ID as ownerId for Cosmos partition key
  const ownerId = (user?.oid as string) ?? (user?.id as string) ?? (user?.name as string) ?? ''

  const initialConversations = devBypass || !ownerId ? [] : await fetchConversations(ownerId)

  return (
    <ChatPageClient
      userName={userName}
      userRole={userRole}
      initialConversations={initialConversations}
    />
  )
}
