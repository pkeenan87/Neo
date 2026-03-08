import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { ChatPageClient } from './ChatPageClient'

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
  const userName = session?.user?.name ?? 'Operator'
  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as string ?? 'admin'

  return <ChatPageClient userName={userName} userRole={userRole} />
}
