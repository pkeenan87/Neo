'use client'

import { useState, useEffect } from 'react'
import styles from './MatrixRain.module.css'

export interface MatrixRainProps {
  className?: string
}

interface Column {
  id: number
  left: string
  duration: number
  delay: number
  chars: string
}

function generateColumns(): Column[] {
  return Array.from({ length: 50 }).map((_, i) => ({
    id: i,
    left: `${(i / 50) * 100}%`,
    duration: 5 + Math.random() * 10,
    delay: Math.random() * 5,
    chars: Array.from({ length: 20 })
      .map(() => String.fromCharCode(0x30a0 + Math.random() * 96))
      .join(''),
  }))
}

export function MatrixRain({ className }: MatrixRainProps) {
  const [columns, setColumns] = useState<Column[]>([])

  useEffect(() => {
    setColumns(generateColumns())
  }, [])

  if (columns.length === 0) return null

  return (
    <div className={`${styles.container} ${className ?? ''}`} aria-hidden="true">
      {columns.map(col => (
        <div
          key={col.id}
          className="matrix-column"
          style={{
            left: col.left,
            animationDuration: `${col.duration}s`,
            animationDelay: `${col.delay}s`,
          }}
        >
          {col.chars}
        </div>
      ))}
    </div>
  )
}
