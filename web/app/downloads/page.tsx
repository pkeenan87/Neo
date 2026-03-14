'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronRight, Download, Monitor, Terminal } from 'lucide-react'
import { detectOS, type DetectedOS } from '@/lib/detect-os'
import { PLATFORMS, type PlatformInfo } from '@/lib/download-config'
import styles from './Downloads.module.css'

const PLATFORM_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Monitor,
  Apple: Monitor,
  Terminal,
}

export interface PlatformCardProps {
  platform: PlatformInfo
  isRecommended: boolean
  className?: string
}

function PlatformCard({ platform, isRecommended, className }: PlatformCardProps) {
  const Icon = PLATFORM_ICONS[platform.iconName] ?? Monitor
  const baseClass = isRecommended ? styles.cardRecommended : styles.card

  return (
    <div className={className ? `${baseClass} ${className}` : baseClass}>
      {isRecommended ? (
        <span className={styles.recommendedBadge}>Recommended for your system</span>
      ) : (
        <span className={styles.badgeSpacer} aria-hidden="true">Recommended for your system</span>
      )}
      <Icon className={styles.cardIcon} />
      <h3 className={styles.cardName}>{platform.name}</h3>
      <p className={styles.cardMeta}>
        {platform.status === 'available'
          ? `v${platform.version} · ${platform.releaseDate}${platform.fileSize ? ` · ${platform.fileSize}` : ''}`
          : 'Coming soon'}
      </p>
      {platform.status === 'available' && platform.downloadPath ? (
        <a
          href={platform.downloadPath}
          download={platform.blobFilename ?? undefined}
          aria-label={`Download Neo CLI for ${platform.name} (${platform.fileExtension})${isRecommended ? ' — recommended for your system' : ''}`}
          className={styles.downloadBtn}
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          Download {platform.fileExtension}
        </a>
      ) : (
        <span className={styles.comingSoonBadge}>Coming Soon</span>
      )}
    </div>
  )
}

export default function DownloadsPage() {
  const [detectedOS, setDetectedOS] = useState<DetectedOS>('unknown')
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const ua = navigator.userAgent
    setDetectedOS(detectOS(ua))
    setIsMobile(/android|iphone|ipad|ipod/i.test(ua))
  }, [])

  const sortedPlatforms = [...PLATFORMS].sort((a, b) => {
    if (a.id === detectedOS) return -1
    if (b.id === detectedOS) return 1
    return 0
  })

  return (
    <div className={styles.page}>
      <Link href="/chat" className={styles.backLink}>
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        Back to Chat
      </Link>

      <div className={styles.header}>
        <h1 className={styles.title}>Download Neo CLI</h1>
        <p className={styles.subtitle}>
          Install the Neo command-line interface for your operating system.
        </p>
      </div>

      {isMobile && (
        <div role="status" aria-live="polite" className={styles.mobileNotice}>
          The Neo CLI is a desktop application. Visit this page from a Windows, macOS, or Linux
          computer to download the installer.
        </div>
      )}

      <div className={styles.cardGrid}>
        {sortedPlatforms.map((platform) => (
          <PlatformCard
            key={platform.id}
            platform={platform}
            isRecommended={platform.id === detectedOS}
          />
        ))}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Install Instructions</h2>
        <p className={styles.sectionDesc}>
          Select your platform for step-by-step installation instructions.
        </p>

        <details className={styles.detailsBlock}>
          <summary className={styles.detailsSummary}>
            <ChevronRight className={styles.summaryChevron} aria-hidden="true" />
            Windows
          </summary>
          <div className={styles.detailsContent}>
            <ol className={styles.numberedList}>
              <li>Download the installer using the <strong>Download .exe</strong> button above.</li>
              <li>
                Run <code className={styles.code}>NeoSetup-*.exe</code> and follow the setup wizard.
                The installer places <code className={styles.code}>neo.exe</code> in Program Files
                and adds it to your system PATH automatically.
              </li>
              <li>
                Open a <strong>new</strong> terminal window and verify the installation:
                <pre className={styles.codeBlock}>neo --version</pre>
              </li>
            </ol>
          </div>
        </details>

        <details className={styles.detailsBlock}>
          <summary className={styles.detailsSummary}>
            <ChevronRight className={styles.summaryChevron} aria-hidden="true" />
            macOS
          </summary>
          <div className={styles.detailsContent}>
            <p className={styles.stepDesc}>macOS support is coming soon. Instructions will be added when the installer is available.</p>
          </div>
        </details>

        <details className={styles.detailsBlock}>
          <summary className={styles.detailsSummary}>
            <ChevronRight className={styles.summaryChevron} aria-hidden="true" />
            Linux
          </summary>
          <div className={styles.detailsContent}>
            <p className={styles.stepDesc}>Linux support is coming soon. Instructions will be added when the installer is available.</p>
          </div>
        </details>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Getting Started</h2>
        <p className={styles.sectionDesc}>
          After installing, follow these steps to connect and start investigating.
        </p>

        <div className={styles.stepList}>
          <div className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Connect to the server</h3>
              <p className={styles.stepDesc}>
                If your Neo server is not on localhost, set the server URL:
              </p>
              <pre className={styles.codeBlock}>export NEO_SERVER_URL=https://neo.yourcompany.com</pre>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Authenticate</h3>
              <p className={styles.stepDesc}>
                Log in with your Entra ID credentials:
              </p>
              <pre className={styles.codeBlock}>neo auth login</pre>
              <p className={styles.stepDesc}>
                Or authenticate with an API key:
              </p>
              <pre className={styles.codeBlock}>neo auth login --api-key YOUR_KEY</pre>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Start the CLI</h3>
              <p className={styles.stepDesc}>
                Launch the interactive REPL:
              </p>
              <pre className={styles.codeBlock}>neo</pre>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Example Commands</h2>
        <p className={styles.sectionDesc}>
          Once you&#39;re in the Neo REPL, try these to get started:
        </p>

        <div className={styles.exampleList}>
          <div className={styles.example}>
            <p className={styles.exampleLabel}>Triage recent incidents</p>
            <pre className={styles.codeBlock}>Show me high severity incidents from the last 24 hours</pre>
          </div>

          <div className={styles.example}>
            <p className={styles.exampleLabel}>Investigate a user</p>
            <pre className={styles.codeBlock}>Investigate user jsmith@company.com — check sign-in logs, MFA status, and risk level</pre>
          </div>

          <div className={styles.example}>
            <p className={styles.exampleLabel}>Hunt for threats</p>
            <pre className={styles.codeBlock}>Search for any sign-ins from TOR exit nodes in the past 7 days</pre>
          </div>

          <div className={styles.example}>
            <p className={styles.exampleLabel}>Run a custom KQL query</p>
            <pre className={styles.codeBlock}>Run this KQL: SigninLogs | where ResultType != 0 | summarize count() by UserPrincipalName</pre>
          </div>
        </div>
      </div>
    </div>
  )
}
