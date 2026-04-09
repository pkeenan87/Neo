"use client";

import { X, FileText } from "lucide-react";
import Image from "next/image";
import styles from "./FileAttachmentBar.module.css";
import type { ClientFile } from "@/hooks/useFileUpload";

export interface FileAttachmentBarProps {
  files: ClientFile[];
  onRemove: (id: string) => void;
  className?: string;
}

export function FileAttachmentBar({
  files,
  onRemove,
  className,
}: FileAttachmentBarProps) {
  return (
    <>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {files.length > 0
          ? `${files.length} file${files.length === 1 ? "" : "s"} attached`
          : ""}
      </span>
      {files.length > 0 && (
        <div
          className={`${styles.bar} ${className ?? ""}`}
          role="list"
          aria-label="Attached files"
        >
          {files.map((f) => (
            <div key={f.id} className={styles.chip} role="listitem">
              {f.previewUrl ? (
                <Image
                  src={f.previewUrl}
                  alt={f.file.name}
                  width={32}
                  height={32}
                  className={styles.thumbnail}
                  unoptimized
                />
              ) : (
                <FileText className={styles.fileIcon} aria-hidden="true" />
              )}
              <span className={styles.filename}>{f.file.name}</span>
              <span className={styles.filesize}>
                {(f.file.size / 1024).toFixed(0)} KB
              </span>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => onRemove(f.id)}
                aria-label={`Remove ${f.file.name}`}
              >
                <X className={styles.removeIcon} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
