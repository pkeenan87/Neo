'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import Image from 'next/image'
import {
  Lock,
  Terminal,
  ChevronRight,
  Sun,
  Moon,
} from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { MatrixRain } from '@/components/MatrixRain'
import { TypewriterText } from '@/components/TypewriterText'
import styles from './LoginPage.module.css'

export interface LoginPageProps {
  bootSequence: boolean
  isAuthenticating: boolean
  onLogin: () => void
  className?: string
}

const QUOTES = [
  "I'm trying to free your mind, Neo. But I can only show you the firewall. You're the one that has to bypass it.",
  "You take the red pill, you stay in Wonderland and I show you how deep the packet capture goes.",
  "The Matrix is a system, Neo. That system is our enemy. When you're inside, you see the vulnerabilities.",
  "Denial is the most predictable of all human responses. But the firewall is absolute.",
  "Everything that has a beginning has an end, Neo. Even a persistent threat actor.",
]

function pickRandomQuote(): string {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)]
}

export function LoginPage({
  bootSequence,
  isAuthenticating,
  onLogin,
  className,
}: LoginPageProps) {
  const { theme, toggleTheme } = useTheme()
  const [randomQuote, setRandomQuote] = useState(QUOTES[0])
  const isDark = theme === 'dark'

  // Pick a random quote only on the client to avoid hydration mismatch
  useEffect(() => {
    setRandomQuote(pickRandomQuote())
  }, [])

  return (
    <div className={`${styles.page} ${className ?? ''}`}>
      <MatrixRain />

      <AnimatePresence>
        {bootSequence ? (
          <motion.div
            key="boot"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={styles.bootSequence}
          >
            <div><TypewriterText text="> INITIALIZING NEO_OS v1.0.1..." delay={0} /></div>
            <div><TypewriterText text="> LOADING SECURITY PROTOCOLS..." delay={1000} /></div>
            <div><TypewriterText text="> ESTABLISHING SECURE CONNECTION..." delay={2000} /></div>
          </motion.div>
        ) : (
          <motion.div
            key="login"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className={styles.loginWrapper}
          >
            <div className={styles.card}>
              {/* Scan line decoration */}
              <div className={styles.scanLine} aria-hidden="true" />

              {/* Logo + title */}
              <div className={styles.cardHeader}>
                <motion.div
                  animate={{
                    rotateY: [0, 360],
                    boxShadow: isDark
                      ? ['0 0 0px rgba(34,197,94,0)', '0 0 20px rgba(34,197,94,0.4)', '0 0 0px rgba(34,197,94,0)']
                      : ['0 0 0px rgba(0,0,0,0)', '0 0 10px rgba(0,0,0,0.1)', '0 0 0px rgba(0,0,0,0)'],
                  }}
                  transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
                  className={styles.shieldIcon}
                >
                  <Image
                    src="/neo-icon.png"
                    alt=""
                    width={72}
                    height={72}
                    aria-hidden="true"
                    className="rounded-lg"
                  />
                </motion.div>

                <h1 className={styles.title}>
                  Neo
                </h1>
                <p className={styles.subtitle}>
                  Security Agent
                </p>

                <div className={styles.quoteWrapper}>
                  <p className={styles.quote}>
                    &ldquo;{randomQuote}&rdquo;
                  </p>
                </div>
              </div>

              {/* SSO button */}
              <div>
                <button
                  onClick={onLogin}
                  disabled={isAuthenticating}
                  aria-busy={isAuthenticating}
                  aria-label={isAuthenticating ? 'Connecting, please wait' : 'Login with Microsoft Entra ID'}
                  className={styles.loginButton}
                >
                  <span className={styles.loginButtonContent}>
                    {isAuthenticating ? (
                      <>
                        <motion.span
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                          className="inline-flex"
                        >
                          <Terminal className="w-5 h-5" aria-hidden="true" />
                        </motion.span>
                        CONNECTING...
                      </>
                    ) : (
                      <>
                        <Lock className="w-5 h-5" aria-hidden="true" />
                        LOGIN WITH ENTRA ID
                        <ChevronRight className="w-5 h-5" aria-hidden="true" />
                      </>
                    )}
                  </span>
                  <span className={styles.buttonSheen} aria-hidden="true" />
                </button>

                <div className="text-center mt-4">
                  <p className={styles.ssoHint}>
                    Single Sign-On Required
                  </p>
                </div>
              </div>

              {/* Footer status bar */}
              <div className={styles.footer}>
                <div className="flex items-center gap-1">
                  <span className={styles.statusDot} aria-hidden="true" />
                  System Online
                </div>
                <div>Node: APP-NEO-PROD-001</div>
              </div>
            </div>

            {/* Below-card footer */}
            <div className={styles.belowCard}>
              <p className={styles.attribution}>
                Secure encrypted link established via Neo-Net
              </p>
              <button
                onClick={toggleTheme}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                className={styles.themeToggle}
              >
                {isDark ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
