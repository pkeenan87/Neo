'use client'

import { useState } from 'react'
import Image from 'next/image'
import { User } from 'lucide-react'
import styles from './UserAvatar.module.css'

export interface UserAvatarProps {
  src?: string
  /** Used as alt text and fallback label. Required when decorative is false. */
  userName?: string
  size?: number
  /** When true, hides the avatar from assistive technology (use inside labeled containers). */
  decorative?: boolean
  className?: string
}

export function UserAvatar({
  src,
  userName,
  size = 32,
  decorative = false,
  className,
}: UserAvatarProps) {
  const [hasError, setHasError] = useState(false)
  const showImage = src && !hasError
  const alt = decorative ? '' : (userName ?? 'User avatar')

  return (
    <div
      className={`${styles.container} ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden={decorative ? 'true' : undefined}
      role={!decorative && !showImage ? 'img' : undefined}
      aria-label={!decorative && !showImage ? alt : undefined}
    >
      {showImage ? (
        <Image
          src={src}
          alt={alt}
          width={size}
          height={size}
          className={styles.image}
          unoptimized={src.startsWith('data:')}
          onError={() => setHasError(true)}
        />
      ) : (
        <User
          style={{ width: size * 0.6, height: size * 0.6 }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
