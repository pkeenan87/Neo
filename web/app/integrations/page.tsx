import { redirect } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { INTEGRATIONS } from '@/lib/integration-registry'
import { getSecretStatuses } from '@/lib/secrets'
import { IntegrationsPage } from '@/components'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Integrations | Neo',
}

export default async function IntegrationsRoute() {
  const authCtx = await getAuthContext()
  if (!authCtx || authCtx.userRole !== 'admin') {
    redirect('/')
  }

  const allSecretKeys = [
    ...new Set(INTEGRATIONS.flatMap((i) => i.secrets.map((s) => s.key))),
  ]
  const secretStatuses = await getSecretStatuses(allSecretKeys)

  return (
    <IntegrationsPage
      integrations={INTEGRATIONS}
      secretStatuses={secretStatuses}
    />
  )
}
