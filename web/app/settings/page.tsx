import { redirect } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { SettingsPage } from '@/components'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Settings | Neo',
}

export default async function SettingsRoute() {
  const authCtx = await getAuthContext()
  if (!authCtx) {
    redirect('/')
  }

  return (
    <SettingsPage
      userName={authCtx.userName}
      userImage={authCtx.userImage}
      userRole={authCtx.userRole}
    />
  )
}
