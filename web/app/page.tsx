'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { LoginPage } from '@/components/LoginPage'

export default function NeoPage() {
  const router = useRouter()
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [bootSequence, setBootSequence] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setBootSequence(false), 3000)
    return () => clearTimeout(timer)
  }, [])

  const handleLogin = () => {
    setIsAuthenticating(true)

    // In dev with DEV_AUTH_BYPASS, skip SSO and go straight to chat
    if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === 'true') {
      router.push('/chat')
      return
    }

    signIn('microsoft-entra-id', { callbackUrl: '/chat' })
  }

  return (
    <LoginPage
      bootSequence={bootSequence}
      isAuthenticating={isAuthenticating}
      onLogin={handleLogin}
    />
  )
}
