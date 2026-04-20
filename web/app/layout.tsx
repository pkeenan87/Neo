import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { JetBrains_Mono, Inter } from 'next/font/google'
import { Agentation } from 'agentation'
import { ThemeProvider } from '@/context/ThemeContext'
import { ToastProvider } from '@/context/ToastContext'
import { Toaster } from '@/components'
import './globals.css'

// Dual-font system (see _plans/gemini-ui-audit.md Phase 2):
//   --font-sans → Inter for UI, body copy, markdown prose
//   --font-mono → JetBrains Mono for code, IPs, hashes, tool names
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Neo — Security Operations Agent',
  description: 'Autonomous AI security operations agent powered by Claude',
}

// Inline script to prevent flash of wrong theme on first load.
// Reads localStorage before React hydrates and adds .dark if needed.
const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('neo-theme');
    var isDark = t === 'dark' || ((t === 'auto' || !t) && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
  } catch(e) {}
})();
`

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const hdrs = await headers()
  const nonce = hdrs.get('x-nonce') ?? undefined

  return (
    // Light mode is default — ThemeContext adds .dark class when toggled
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* suppressHydrationWarning: nonce differs between SSR and client */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-body">
        <ThemeProvider>
          <ToastProvider>
            {children}
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
        {process.env.NODE_ENV === 'development' && <Agentation />}
      </body>
    </html>
  )
}
