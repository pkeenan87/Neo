import { notFound } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { ChatPageClient } from '../ChatPageClient'

const CONV_ID_RE = /^conv_[0-9a-f-]{36}$/i

interface ChatByIdPageProps {
  params: Promise<{ id: string }>
}

async function fetchConversation(id: string, ownerId: string) {
  try {
    const { env } = await import('@/lib/config')
    if (!env.COSMOS_ENDPOINT || env.MOCK_MODE) return null

    const { getConversation } = await import('@/lib/conversation-store')
    return await getConversation(id, ownerId)
  } catch {
    return null
  }
}

export default async function ChatByIdPage({ params }: ChatByIdPageProps) {
  const { id } = await params

  if (!CONV_ID_RE.test(id)) {
    notFound()
  }

  const authCtx = await getAuthContext()
  if (!authCtx || !authCtx.ownerId) {
    notFound()
  }

  const conversation = await fetchConversation(id, authCtx.ownerId)
  if (!conversation) {
    notFound()
  }

  return (
    <ChatPageClient
      initialConversation={conversation}
    />
  )
}
