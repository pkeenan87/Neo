# Spec for Image & File Upload Support

branch: claude/feature/image-file-upload-support

## Summary

Add support for users to attach images (JPEG, PNG, GIF, WebP) and PDF files to Neo chat messages in the web interface. Attachments are forwarded to the Claude API as base64-encoded content blocks alongside the text prompt, unlocking multimodal analysis — screenshots of security alerts, PDF policy documents, architecture diagrams, and clipboard pastes. Files are stored in Azure Blob Storage (not raw base64 in Cosmos DB) with blob reference URLs in conversation records.

## Functional Requirements

### Frontend (Chat Input Component)
- Add a file picker button (paperclip/attach icon) to the chat input area, next to the send button
- Support drag-and-drop onto the chat input area to attach files
- Support clipboard paste (Ctrl+V / Cmd+V) to attach screenshots directly
- Show preview thumbnails for attached images and a file icon + name for PDFs
- Allow removing individual attachments before sending
- Display attachment count badge when files are queued
- Accepted file types: JPEG, PNG, GIF, WebP (images) and PDF documents
- Show clear error messages for unsupported file types or files exceeding size limits
- When files are attached, send the message as `multipart/form-data` instead of JSON
- Disable the send button while files are uploading/processing

### Backend (API Route)
- Parse multipart uploads in the agent POST route using a multipart parsing library (e.g., `busboy` or `formidable`)
- Validate file types and sizes server-side before processing:
  - Images: max 20MB per file
  - PDFs: max 32MB, max 100 pages
  - Reject unsupported MIME types with a clear error message
- Convert uploaded files to base64 and build Claude content block arrays:
  - Images: `{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } }`
  - PDFs: `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "..." } }`
- Switch the user message `content` field from a plain string to an array of content blocks when files are present:
  - Text block: `{ type: "text", text: "user message" }`
  - Plus one image/document block per attached file
- When no files are attached, keep the existing plain string format for backward compatibility

### Agent Pipeline
- `runAgentLoop` in `agent.ts` already accepts `Message[]` which supports both string and array content — minimal change needed
- The `content` field in the user message just needs to be an array of blocks instead of a string when attachments exist
- Existing tool result injection and context management should work with array content blocks

### Storage (Cosmos DB + Azure Blob Storage)
- Do NOT store raw base64 data in conversation records — it would bloat Cosmos DB documents
- Upload files to an Azure Blob Storage container (reuse existing storage account or create a new container)
- Store blob reference URLs in conversation messages as metadata
- On conversation reload, display a placeholder thumbnail/icon with the file name — do not reconstitute the full base64 (the Claude API call already happened)

### Validation & Limits
- Image size: max 20MB per file (recommended < 5MB for performance)
- PDF size: max 32MB per file, max 100 pages
- Total attachments per message: max 5 files
- Enforce limits both client-side (immediate feedback) and server-side (authoritative)

## Possible Edge Cases

- Very large images (near 20MB) may cause slow uploads and base64 encoding delays — show a progress indicator
- Clipboard paste may produce BMP or other formats — convert to PNG on the client before uploading
- PDFs with many pages may hit Claude's context limits — warn the user if a PDF exceeds 50 pages
- The `multipart/form-data` switch changes the content type — the existing JSON parsing in the route must handle both formats
- Conversation reload should gracefully handle messages with file references where the blob has expired or been deleted
- The injection guard scans text content — it should skip binary/base64 content blocks
- Token estimation in context-manager needs to account for image tokens (Claude charges ~1600 tokens per 1024x1024 image tile)

## Acceptance Criteria

- [ ] Users can attach images via file picker, drag-and-drop, or clipboard paste
- [ ] Users can attach PDF files via file picker or drag-and-drop
- [ ] Preview thumbnails display for attached images; file icon + name for PDFs
- [ ] Attachments can be removed before sending
- [ ] Agent correctly receives and analyzes attached images and PDFs
- [ ] File type and size validation works both client-side and server-side
- [ ] Files are stored in Azure Blob Storage, not raw base64 in Cosmos DB
- [ ] Conversation reload shows file placeholders for past attachments
- [ ] Existing text-only chat continues to work unchanged
- [ ] Injection guard does not scan base64 content blocks

## Open Questions

- Should we support multiple file types in a single message (e.g., 2 images + 1 PDF)? Yes
- Should the blob storage container require a new env var or reuse the existing CLI storage account? new variable
- Should we add file upload support to the Teams bot channel in this iteration or defer? add to teams bot too
- What should the UI look like when a conversation with attachments is reloaded — show the original thumbnail or just a file reference? file reference

## Testing Guidelines

Create test files in `./test/` for:

- File type validation: accepted MIME types pass, unsupported types rejected
- File size validation: files within limits accepted, oversized files rejected
- Content block construction: text + image blocks built correctly for Claude API
- Content block construction: text + PDF blocks built correctly
- Backward compatibility: text-only messages still use plain string format
- Attachment limit: max 5 files per message enforced
