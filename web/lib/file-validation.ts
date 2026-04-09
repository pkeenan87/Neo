import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_DOC_TYPES,
  MAX_IMAGE_SIZE,
  MAX_DOC_SIZE,
} from "./types";

export function isImageType(mimetype: string): boolean {
  return ACCEPTED_IMAGE_TYPES.has(mimetype);
}

export function isDocumentType(mimetype: string): boolean {
  return ACCEPTED_DOC_TYPES.has(mimetype);
}

export function isAcceptedType(mimetype: string): boolean {
  return isImageType(mimetype) || isDocumentType(mimetype);
}

export function validateFile(
  mimetype: string,
  size: number,
): { valid: boolean; error?: string } {
  if (!isAcceptedType(mimetype)) {
    return {
      valid: false,
      error: "Unsupported file type. Accepted: JPEG, PNG, GIF, WebP, PDF.",
    };
  }

  if (isImageType(mimetype) && size > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `Image too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum: 20 MB.`,
    };
  }

  if (isDocumentType(mimetype) && size > MAX_DOC_SIZE) {
    return {
      valid: false,
      error: `Document too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum: 32 MB.`,
    };
  }

  return { valid: true };
}

// ── Magic byte validation ────────────────────────────────────

const MAGIC_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  "image/jpeg":      (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  "image/png":       (b) => b.length >= 4 && b.toString("hex", 0, 4) === "89504e47",
  "image/gif":       (b) => b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a"),
  "image/webp":      (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  "application/pdf": (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-",
};

/**
 * Verify file content matches the declared MIME type by checking magic bytes.
 * Returns false if the file content doesn't match the expected signature.
 */
export function validateMagicBytes(mimetype: string, buffer: Buffer): boolean {
  const check = MAGIC_CHECKS[mimetype];
  if (!check) return true; // unknown types pass (only known types are accepted anyway)
  return check(buffer);
}
