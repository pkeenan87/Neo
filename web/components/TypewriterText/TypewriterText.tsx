'use client'

import { useEffect, useState } from 'react'

export interface TypewriterTextProps {
  text: string
  delay?: number
  className?: string
}

export function TypewriterText({ text, delay = 0, className }: TypewriterTextProps) {
  const [displayedText, setDisplayedText] = useState('')

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const timeout = setTimeout(() => {
      let i = 0
      interval = setInterval(() => {
        setDisplayedText(text.slice(0, i + 1))
        i++
        if (i === text.length && interval !== null) clearInterval(interval)
      }, 50)
    }, delay)
    return () => {
      clearTimeout(timeout)
      if (interval !== null) clearInterval(interval)
    }
  }, [text, delay])

  return <span className={className} aria-label={text}>{displayedText}</span>
}
