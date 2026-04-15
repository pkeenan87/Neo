import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_DOC_TYPES,
  ACCEPTED_CSV_TYPES,
  ACCEPTED_TXT_TYPES,
  MAX_IMAGE_SIZE,
  MAX_DOC_SIZE,
  MAX_CSV_SIZE,
  MAX_TXT_SIZE,
} from "./types";

export function isImageType(mimetype: string): boolean {
  return ACCEPTED_IMAGE_TYPES.has(mimetype);
}

export function isDocumentType(mimetype: string): boolean {
  return ACCEPTED_DOC_TYPES.has(mimetype);
}

/**
 * Identify TXT files by MIME type or .txt extension.
 * Explicitly excludes .csv files to prevent disambiguation overlap.
 */
export function isTxtType(mimetype: string, filename?: string): boolean {
  if (filename?.toLowerCase().endsWith(".csv")) return false;
  if (ACCEPTED_TXT_TYPES.has(mimetype)) return true;
  if (filename?.toLowerCase().endsWith(".txt")) return true;
  return false;
}

/**
 * Identify CSVs by either an accepted MIME type OR a .csv extension.
 * Browsers frequently report CSVs with generic fallback types (e.g.
 * application/octet-stream or application/vnd.ms-excel), so we rely
 * on the extension when the declared MIME type is ambiguous.
 * Explicitly excludes .txt files to prevent disambiguation overlap.
 */
export function isCsvType(mimetype: string, filename?: string): boolean {
  if (filename?.toLowerCase().endsWith(".txt")) return false;
  if (mimetype === "text/csv" || mimetype === "application/csv") return true;
  if (!filename) return false;
  if (!filename.toLowerCase().endsWith(".csv")) return false;
  // Only fall through on ambiguous-but-commonly-valid MIME types.
  return ACCEPTED_CSV_TYPES.has(mimetype) || mimetype === "";
}

export function isAcceptedType(mimetype: string, filename?: string): boolean {
  return (
    isImageType(mimetype) ||
    isDocumentType(mimetype) ||
    isCsvType(mimetype, filename) ||
    isTxtType(mimetype, filename)
  );
}

export function validateFile(
  mimetype: string,
  size: number,
  filename?: string,
): { valid: boolean; error?: string } {
  if (!isAcceptedType(mimetype, filename)) {
    return {
      valid: false,
      error: "Unsupported file type. Accepted: JPEG, PNG, GIF, WebP, PDF, CSV, TXT.",
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

  if (isCsvType(mimetype, filename) && size > MAX_CSV_SIZE) {
    return {
      valid: false,
      error: `CSV too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum: 50 MB.`,
    };
  }

  if (isTxtType(mimetype, filename) && size > MAX_TXT_SIZE) {
    return {
      valid: false,
      error: `Text file too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum: 2 MB.`,
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
 *
 * CSVs are plain text and have no reliable magic-byte signature, so they
 * bypass this check — content validation happens separately in
 * classifyCsv() via csv-parse.
 */
export function validateMagicBytes(
  mimetype: string,
  buffer: Buffer,
  filename?: string,
): boolean {
  if (isCsvType(mimetype, filename)) return true;
  if (isTxtType(mimetype, filename)) return true;
  const check = MAGIC_CHECKS[mimetype];
  if (!check) return true; // unknown types pass (only known types are accepted anyway)
  return check(buffer);
}
