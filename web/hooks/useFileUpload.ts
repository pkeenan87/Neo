"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_DOC_TYPES,
  MAX_IMAGE_SIZE,
  MAX_DOC_SIZE,
  MAX_FILES_PER_MESSAGE,
} from "@/lib/types";

export interface ClientFile {
  id: string;
  file: File;
  previewUrl: string | null;
}

function isAcceptedType(type: string): boolean {
  return ACCEPTED_IMAGE_TYPES.has(type) || ACCEPTED_DOC_TYPES.has(type);
}

function maxSizeForType(type: string): number {
  return ACCEPTED_DOC_TYPES.has(type) ? MAX_DOC_SIZE : MAX_IMAGE_SIZE;
}

export function useFileUpload() {
  const [files, setFiles] = useState<ClientFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const idCounter = useRef(0);

  // Clean up preview URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    setError(null);
    const incoming = Array.from(fileList);

    setFiles((prev) => {
      const remaining = MAX_FILES_PER_MESSAGE - prev.length;
      if (remaining <= 0) {
        setError(`Maximum ${MAX_FILES_PER_MESSAGE} files per message.`);
        return prev;
      }

      const toAdd: ClientFile[] = [];
      for (const file of incoming.slice(0, remaining)) {
        if (!isAcceptedType(file.type)) {
          setError(`Unsupported file type: ${file.type || file.name}. Use JPEG, PNG, GIF, WebP, or PDF.`);
          continue;
        }
        const max = maxSizeForType(file.type);
        if (file.size > max) {
          setError(`${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: ${(max / 1024 / 1024).toFixed(0)} MB.`);
          continue;
        }
        const previewUrl = ACCEPTED_IMAGE_TYPES.has(file.type)
          ? URL.createObjectURL(file)
          : null;
        toAdd.push({
          id: `file-${++idCounter.current}`,
          file,
          previewUrl,
        });
      }

      if (incoming.length > remaining) {
        setError(`Only ${remaining} more file(s) allowed (max ${MAX_FILES_PER_MESSAGE}).`);
      }

      return [...prev, ...toAdd];
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setError(null);
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });
    setError(null);
  }, []);

  return {
    files,
    addFiles,
    removeFile,
    clearFiles,
    hasFiles: files.length > 0,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}
