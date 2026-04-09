# Image & File Upload Support

## Context

Add multimodal file upload support to Neo's web and Teams interfaces, allowing users to attach images (JPEG, PNG, GIF, WebP) and PDFs alongside chat messages. Files are base64-encoded for the Claude API, stored in Azure Blob Storage for persistence (not Cosmos DB), and the agent pipeline already supports array content blocks via the Anthropic SDK's `MessageParam` type. The main work is frontend UI, multipart request parsing, blob storage integration, and extending the injection guard and token estimator for non-text content.

---

## Key Design Decisions

- **Multipart/form-data only when files present** — Keep JSON for text-only messages (backward compatible). Switch to `multipart/form-data` only when files are attached, detected by content-type header in the API route.
- **`busboy` for multipart parsing** — Lightweight, streaming parser. Next.js App Router doesn't have built-in multipart support; `busboy` is the established choice for streaming file uploads without buffering entire files in memory.
- **New `useFileUpload` hook** — Manages attached files state, preview generation, validation, and cleanup. Keeps ChatInterface clean.
- **New `FileAttachmentBar` component** — Renders below the textarea showing attached file thumbnails/icons with remove buttons. Follows the project's component folder pattern.
- **Blob storage for persistence, base64 for Claude** — Files are uploaded to Azure Blob Storage and referenced by URL in Cosmos DB messages. The raw base64 is built in-memory for the Claude API call and not persisted. On conversation reload, file references display as placeholders (filename + icon).
- **New env var `UPLOAD_STORAGE_CONTAINER`** — Separate blob container from CLI downloads. Reuses the existing `CLI_STORAGE_ACCOUNT` for the storage account.
- **Image token estimation** — Claude charges ~1600 tokens per 1024x1024 tile. The context manager's `contentCharCount` function needs a case for `type: "image"` and `type: "document"` blocks.
- **Injection guard scans text only** — `scanUserInput` extracts text blocks from array content and scans those. Image/document blocks are skipped entirely.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `FileAttachment` interface, extend `AgentRequest` with optional `files` metadata, add `ACCEPTED_IMAGE_TYPES` and `ACCEPTED_DOC_TYPES` constants |
| `web/lib/config.ts` | Add `UPLOAD_STORAGE_CONTAINER` env var |
| `web/lib/upload-storage.ts` | New file — blob storage upload/URL helpers using existing `BlobServiceClient` pattern from downloads route |
| `web/lib/file-validation.ts` | New file — server-side MIME type validation, size limits, page count check for PDFs |
| `web/lib/content-blocks.ts` | New file — builds Claude content block arrays from text + files (image/document blocks) |
| `web/lib/injection-guard.ts` | Update `scanUserInput` to accept `string \| Message["content"]`, extract text blocks for scanning, skip binary blocks |
| `web/lib/context-manager.ts` | Update `contentCharCount` to estimate tokens for image blocks (~1600 tokens per tile) and document blocks |
| `web/app/api/agent/route.ts` | Add multipart request parsing branch (detect content-type), validate files, build content blocks, upload to blob storage, push array content to session |
| `web/app/api/teams/messages/route.ts` | Extract `context.activity.attachments`, download file content, build content blocks, pass to agent loop |
| `web/components/ChatInterface/ChatInterface.tsx` | Add file picker button, drag-and-drop handler, clipboard paste handler, integrate `useFileUpload` hook, switch to `multipart/form-data` when files present |
| `web/components/ChatInterface/ChatInterface.module.css` | Styles for file picker button, drag-drop overlay, attachment bar |
| `web/components/FileAttachmentBar/FileAttachmentBar.tsx` | New component — renders attached file previews/icons with remove buttons |
| `web/components/FileAttachmentBar/FileAttachmentBar.module.css` | New CSS module for attachment bar |
| `web/components/FileAttachmentBar/index.ts` | Barrel export |
| `web/hooks/useFileUpload.ts` | New hook — manages file state, validation, preview generation, cleanup |
| `web/components/index.ts` | Add `FileAttachmentBar` to barrel exports |
| `.env.example` | Add `UPLOAD_STORAGE_CONTAINER` |
| `docs/configuration.md` | Document `UPLOAD_STORAGE_CONTAINER` env var and blob storage setup |
| `package.json` (web) | Add `busboy` and `@types/busboy` dependencies |
| `test/file-upload.test.js` | New test file for validation, content block construction, token estimation |

---

## Implementation Steps

### 1. Add dependencies

- Install `busboy` and `@types/busboy` in the web package for multipart parsing

### 2. Add types and constants to `web/lib/types.ts`

- Add `FileAttachment` interface with fields: `filename` (string), `mimetype` (string), `size` (number), `buffer` (Buffer — server only), `blobUrl` (string, optional — set after upload)
- Add `ACCEPTED_IMAGE_TYPES` constant: `new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])`
- Add `ACCEPTED_DOC_TYPES` constant: `new Set(["application/pdf"])`
- Add `MAX_IMAGE_SIZE` (20MB), `MAX_DOC_SIZE` (32MB), `MAX_FILES_PER_MESSAGE` (5) constants
- Add `UPLOAD_STORAGE_CONTAINER` to `EnvConfig` interface (string | undefined)
- Extend `AgentRequest` with optional `fileRefs?: { filename: string; mimetype: string; blobUrl: string }[]` for persisted file references in Cosmos DB messages

### 3. Add env var to `web/lib/config.ts`

- Add `UPLOAD_STORAGE_CONTAINER: process.env.UPLOAD_STORAGE_CONTAINER` to the env object

### 4. Create `web/lib/file-validation.ts`

- Export `validateFile(mimetype: string, size: number): { valid: boolean; error?: string }` — checks MIME type against accepted sets, checks size against limits
- Export `isImageType(mimetype: string): boolean` and `isDocumentType(mimetype: string): boolean` helpers

### 5. Create `web/lib/upload-storage.ts`

- Follow the lazy singleton pattern from `web/app/api/downloads/[filename]/route.ts`
- Export `getUploadContainerClient()` — returns a `ContainerClient` for the upload container using `ManagedIdentityCredential` and `CLI_STORAGE_ACCOUNT`
- Export `uploadFile(filename: string, buffer: Buffer, mimetype: string): Promise<string>` — uploads to blob storage with a UUID-prefixed filename to prevent collisions, returns the blob URL
- Export `generateBlobName(originalFilename: string): string` — prefixes with UUID + timestamp for uniqueness

### 6. Create `web/lib/content-blocks.ts`

- Export `buildContentBlocks(text: string, files: FileAttachment[]): Anthropic.Messages.ContentBlockParam[]` — builds the content array:
  - Always starts with a text block: `{ type: "text", text }`
  - For each image file: `{ type: "image", source: { type: "base64", media_type, data: buffer.toString("base64") } }`
  - For each PDF file: `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }`
- Export `buildPersistedContent(text: string, fileRefs: { filename: string; mimetype: string; blobUrl: string }[]): Message["content"]` — builds a content array with text + file reference metadata blocks for Cosmos DB storage (no base64, just URLs)

### 7. Update `web/lib/injection-guard.ts`

- Change `scanUserInput` signature to accept `message: string | Anthropic.Messages.MessageParam["content"]`
- When message is a string, scan as before
- When message is an array, iterate blocks, extract text from `type: "text"` blocks, concatenate, and scan the combined text
- Skip `type: "image"` and `type: "document"` blocks entirely

### 8. Update `web/lib/context-manager.ts`

- In `contentCharCount`, add a case for `block.type === "image"`: estimate ~1600 tokens per image (multiply by `CHARS_PER_TOKEN` to convert to char equivalent, i.e., ~5600 chars)
- Add a case for `block.type === "document"`: estimate ~2000 tokens per PDF page. Since page count isn't in the block, use a rough heuristic of ~8000 chars per document block (covers ~2-3 pages average)
- These are conservative estimates to prevent context overflow

### 9. Update `web/app/api/agent/route.ts`

- At the top of the POST handler, check `request.headers.get("content-type")` for `multipart/form-data`
- If multipart: parse using `busboy`, extract text fields (`sessionId`, `message`, `channel`, `model`) and file fields into a `FileAttachment[]` array
- If JSON: parse as before (existing path, no change)
- Validate each file with `validateFile()`, return 400 for invalid files
- Enforce `MAX_FILES_PER_MESSAGE` limit
- Build Claude content blocks with `buildContentBlocks(text, files)`
- Upload files to blob storage with `uploadFile()`
- Build persisted content (with blob URLs, no base64) for Cosmos DB
- Push persisted content to `session.messages` (for Cosmos), but pass Claude content blocks (with base64) to `runAgentLoop`
- Update the injection scan call to pass the text portion only (or the updated `scanUserInput` that handles arrays)

### 10. Update `web/app/api/teams/messages/route.ts`

- After extracting `messageText` (line 354), check `context.activity.attachments` for file attachments
- For each attachment with a `contentUrl`, download the file content using `fetch(attachment.contentUrl)`
- Validate MIME type and size
- Build content blocks array combining text + downloaded files
- Pass array content to the agent loop instead of plain text
- Upload files to blob storage for persistence

### 11. Create `web/hooks/useFileUpload.ts`

- Custom hook managing: `files` state array, `addFiles(fileList: FileList)`, `removeFile(index: number)`, `clearFiles()`, `hasFiles` boolean
- Client-side validation: check MIME type, file size, max count — set error state for rejected files
- Generate preview URLs for images using `URL.createObjectURL()`
- Clean up object URLs on unmount or file removal
- Return `{ files, addFiles, removeFile, clearFiles, hasFiles, error }`

### 12. Create `web/components/FileAttachmentBar/` component

- New component folder with `FileAttachmentBar.tsx`, `FileAttachmentBar.module.css`, `index.ts`
- Renders a horizontal bar below the textarea when files are attached
- Each file shows: image thumbnail (for images) or PDF icon + filename (for PDFs), file size, and an X remove button
- Follows the project's component pattern (CSS module, barrel export, TypeScript props interface)
- Add to `web/components/index.ts` barrel

### 13. Update `web/components/ChatInterface/ChatInterface.tsx`

- Import and use `useFileUpload` hook
- Add a file picker button (paperclip icon) in the input actions area, before the send button
- Add `onDragOver`/`onDrop` handlers on the input group div for drag-and-drop
- Add `onPaste` handler on the textarea for clipboard image paste
- Render `FileAttachmentBar` between the textarea and the action buttons when files are attached
- Update `handleSendMessage` to:
  - When `hasFiles`: build `FormData` with `message`, `sessionId`, `channel`, `model` fields plus file blobs, send as `multipart/form-data`
  - When no files: send JSON as before (existing path unchanged)
- Clear files after successful send

### 14. Update `web/components/ChatInterface/ChatInterface.module.css`

- Add styles for: file picker button (icon button matching send button style), drag-drop overlay (semi-transparent overlay with dashed border), active drag state

### 15. Update conversation reload in `conversationToChatMessages`

- Detect messages with file reference metadata in their content blocks
- Render file references as `[Attached: filename.pdf]` or `[Attached: screenshot.png]` text placeholders
- This is the "file reference" behavior specified in the open questions

### 16. Update `.env.example` and docs

- Add `UPLOAD_STORAGE_CONTAINER=chat-attachments` to `.env.example`
- Add documentation in `docs/configuration.md` under the Blob Storage section

### 17. Create test file

- Create `test/file-upload.test.js` with:
  - MIME type validation: JPEG/PNG/GIF/WebP accepted, BMP/TIFF rejected, PDF accepted
  - Size validation: within limits accepted, oversized rejected
  - Content block construction: text + 1 image builds correct 2-element array
  - Content block construction: text + 1 PDF builds correct 2-element array
  - Content block construction: text only returns plain string (backward compat)
  - Max files: 6 files rejected, 5 files accepted
  - Image token estimation: single image block returns ~1600 tokens equivalent

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Run tests: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/file-upload.test.js`
3. Run existing tests for regressions: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/enhanced-observability-logging.test.js test/appomni-risk-analyzer.test.js test/threatlocker-maintenance-mode.test.js`
4. Manual: Run `npm run dev`, attach an image in the chat, verify the agent analyzes it
5. Manual: Attach a PDF, verify the agent can summarize its contents
6. Manual: Drag-and-drop a file onto the input area, verify it attaches
7. Manual: Paste a screenshot (Cmd+V), verify it attaches
8. Manual: Attach 6 files, verify the 6th is rejected with a clear error
9. Manual: Reload a conversation with attachments, verify file reference placeholders display
