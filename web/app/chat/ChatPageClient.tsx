'use client'

import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { ChatInterface } from '@/components/ChatInterface'

interface ChatPageClientProps {
  userName: string
  userRole: string
}

export function ChatPageClient({ userName, userRole }: ChatPageClientProps) {
  const router = useRouter()

  const handleLogout = () => {
    // In dev with bypass, just navigate back
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
    />
  )
}
