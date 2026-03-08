import type { Metadata } from 'next'
import { JetBrains_Mono } from 'next/font/google'
import { Agentation } from 'agentation'
import { ThemeProvider } from '@/context/ThemeContext'
import './globals.css'

// Single mono font across all roles per design-tokens.md
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
    if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  } catch(e) {}
})();
`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    // Light mode is default — ThemeContext adds .dark class when toggled
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <head>
        {/* suppressHydrationWarning: nonce differs between SSR and client */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-mono">
        <ThemeProvider>{children}</ThemeProvider>
        {process.env.NODE_ENV === 'development' && <Agentation />}
      </body>
    </html>
  )
}
