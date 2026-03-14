import { redirect, notFound } from 'next/navigation'
import { getAuthContext } from '@/lib/get-auth-context'
import { getIntegration } from '@/lib/integration-registry'
import { getSecretStatuses } from '@/lib/secrets'
import { IntegrationDetailPage } from '@/components'
import type { Metadata } from 'next'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const integration = getIntegration(slug)
  return {
    title: integration
      ? `${integration.name} Integration | Neo`
      : 'Integration Details | Neo',
  }
}

export default async function IntegrationDetailRoute({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const authCtx = await getAuthContext()
  if (!authCtx || authCtx.userRole !== 'admin') {
    redirect('/')
  }

  const { slug } = await params
  const integration = getIntegration(slug)
  if (!integration) {
    notFound()
  }

  const secretKeys = integration.secrets.map((s) => s.key)
  const secretStatuses = await getSecretStatuses(secretKeys)

  return (
    <IntegrationDetailPage
      integration={integration}
      secretStatuses={secretStatuses}
    />
  )
}
