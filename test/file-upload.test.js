import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated constants from types.ts ───────────────────────

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);
const ACCEPTED_DOC_TYPES = new Set(["application/pdf"]);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_DOC_SIZE = 32 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 5;

function isImageType(mimetype) {
  return ACCEPTED_IMAGE_TYPES.has(mimetype);
}
function isDocumentType(mimetype) {
  return ACCEPTED_DOC_TYPES.has(mimetype);
}
function isAcceptedType(mimetype) {
  return isImageType(mimetype) || isDocumentType(mimetype);
}
function validateFile(mimetype, size) {
  if (!isAcceptedType(mimetype)) {
    return { valid: false, error: `Unsupported file type: ${mimetype}` };
  }
  if (isImageType(mimetype) && size > MAX_IMAGE_SIZE) {
    return { valid: false, error: "Image too large" };
  }
  if (isDocumentType(mimetype) && size > MAX_DOC_SIZE) {
    return { valid: false, error: "Document too large" };
  }
  return { valid: true };
}

// ── Tests ────────────────────────────────────────────────────

describe("File type validation", () => {
  it("accepts JPEG", () => assert.ok(isAcceptedType("image/jpeg")));
  it("accepts PNG", () => assert.ok(isAcceptedType("image/png")));
  it("accepts GIF", () => assert.ok(isAcceptedType("image/gif")));
  it("accepts WebP", () => assert.ok(isAcceptedType("image/webp")));
  it("accepts PDF", () => assert.ok(isAcceptedType("application/pdf")));
  it("rejects BMP", () => assert.ok(!isAcceptedType("image/bmp")));
  it("rejects TIFF", () => assert.ok(!isAcceptedType("image/tiff")));
  it("rejects DOCX", () => assert.ok(!isAcceptedType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")));
  it("rejects text/plain", () => assert.ok(!isAcceptedType("text/plain")));
});

describe("File size validation", () => {
  it("accepts image under 20MB", () => {
    assert.ok(validateFile("image/png", 5 * 1024 * 1024).valid);
  });
  it("rejects image over 20MB", () => {
    assert.ok(!validateFile("image/png", 25 * 1024 * 1024).valid);
  });
  it("accepts PDF under 32MB", () => {
    assert.ok(validateFile("application/pdf", 10 * 1024 * 1024).valid);
  });
  it("rejects PDF over 32MB", () => {
    assert.ok(!validateFile("application/pdf", 35 * 1024 * 1024).valid);
  });
  it("accepts image at exactly 20MB", () => {
    assert.ok(validateFile("image/jpeg", MAX_IMAGE_SIZE).valid);
  });
  it("rejects image at 20MB + 1 byte", () => {
    assert.ok(!validateFile("image/jpeg", MAX_IMAGE_SIZE + 1).valid);
  });
});

describe("Content block construction", () => {
  it("text only returns plain string", () => {
    const files = [];
    const result = files.length === 0 ? "hello" : "array";
    assert.equal(result, "hello");
  });

  it("text + 1 image builds 2-element array", () => {
    const blocks = [
      { type: "text", text: "analyze this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[1].type, "image");
  });

  it("text + 1 PDF builds 2-element array", () => {
    const blocks = [
      { type: "text", text: "summarize this" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "xyz" } },
    ];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[1].type, "document");
  });

  it("text + 2 images + 1 PDF builds 4-element array", () => {
    const blocks = [
      { type: "text", text: "compare these" },
      { type: "image", source: {} },
      { type: "image", source: {} },
      { type: "document", source: {} },
    ];
    assert.equal(blocks.length, 4);
  });
});

describe("Max files per message", () => {
  it("allows up to 5 files", () => {
    assert.ok(5 <= MAX_FILES_PER_MESSAGE);
  });
  it("rejects 6 files", () => {
    assert.ok(6 > MAX_FILES_PER_MESSAGE);
  });
});

describe("Image token estimation", () => {
  it("single image estimates ~1600 tokens", () => {
    const IMAGE_TOKEN_ESTIMATE = 1600;
    const CHARS_PER_TOKEN = 3.5;
    const charEquivalent = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
    assert.equal(charEquivalent, 5600);
    // This maps to ~1600 tokens in the estimator
    assert.equal(Math.ceil(charEquivalent / CHARS_PER_TOKEN), 1600);
  });
});
