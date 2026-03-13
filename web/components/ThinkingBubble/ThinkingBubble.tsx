import styles from './ThinkingBubble.module.css'

export interface ThinkingBubbleProps {
  className?: string
}

export function ThinkingBubble({ className }: ThinkingBubbleProps) {
  return (
    <div
      className={`${styles.bubble} ${className ?? ''}`}
      aria-hidden="true"
    >
      <span className={styles.dot} />
      <span className={`${styles.dot} ${styles.dotDelay1}`} />
      <span className={`${styles.dot} ${styles.dotDelay2}`} />
    </div>
  )
}
