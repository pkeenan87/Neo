import { redirect } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { ChatLayoutClient } from './ChatLayoutClient'
import { DEFAULT_MODEL } from '@/lib/config'
import type { ConversationMeta } from '@/lib/types'

function modelDisplayName(modelId: string): string {
  // Extract version from model ID (e.g., "claude-sonnet-4-6" → "4.6")
  const versionMatch = modelId.match(/(\d+)-(\d+)/)
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : ""
  const suffix = version ? ` ${version}` : ""

  if (modelId.includes("opus")) return `Claude Opus${suffix}`
  if (modelId.includes("sonnet")) return `Claude Sonnet${suffix}`
  if (modelId.includes("haiku")) return `Claude Haiku${suffix}`
  return modelId
}

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
      defaultModelName={modelDisplayName(DEFAULT_MODEL)}
    >
      {children}
    </ChatLayoutClient>
  )
}
