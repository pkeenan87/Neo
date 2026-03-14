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
      {isRecommended && (
        <span className={styles.recommendedBadge}>Recommended for your system</span>
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

        <details className={styles.detailsBlock}>
          <summary className={styles.detailsSummary}>
            <ChevronRight className={styles.summaryChevron} aria-hidden="true" />
            Windows
          </summary>
          <div className={styles.detailsContent}>
            <ol>
              <li>Download the installer using the button above.</li>
              <li>
                Run <code className={styles.code}>NeoSetup-*.exe</code> and follow the setup wizard.
                The installer places <code className={styles.code}>neo.exe</code> in Program Files
                and adds it to your system PATH.
              </li>
              <li>
                Open a new terminal and verify the installation:
                <br />
                <code className={styles.code}>neo --version</code>
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
            <p>Instructions will be available when this platform is supported.</p>
          </div>
        </details>

        <details className={styles.detailsBlock}>
          <summary className={styles.detailsSummary}>
            <ChevronRight className={styles.summaryChevron} aria-hidden="true" />
            Linux
          </summary>
          <div className={styles.detailsContent}>
            <p>Instructions will be available when this platform is supported.</p>
          </div>
        </details>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Quick Start</h2>

        <div className={styles.stepList}>
          <div className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Set the server URL</h3>
              <p className={styles.stepDesc}>
                If your Neo server is not running on localhost, set the{' '}
                <code className={styles.code}>NEO_SERVER_URL</code> environment variable to point to
                your server (e.g.{' '}
                <code className={styles.code}>https://neo.example.com</code>). The default is{' '}
                <code className={styles.code}>http://localhost:3000</code>.
              </p>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Authenticate</h3>
              <p className={styles.stepDesc}>
                Run <code className={styles.code}>neo auth login</code> to authenticate via your
                browser with Entra ID, or use{' '}
                <code className={styles.code}>neo auth login --api-key YOUR_KEY</code> to
                authenticate with an API key.
              </p>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Start the CLI</h3>
              <p className={styles.stepDesc}>
                Run <code className={styles.code}>neo</code> to start the interactive REPL. You can
                begin investigating security incidents immediately.
              </p>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNumber}>4</span>
            <div className={styles.stepBody}>
              <h3 className={styles.stepTitle}>Try a command</h3>
              <p className={styles.stepDesc}>
                Ask a question like{' '}
                <code className={styles.code}>
                  Show me high severity incidents from the last 24 hours
                </code>{' '}
                and Neo will query Sentinel and present the findings.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
