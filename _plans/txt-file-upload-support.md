# TXT File Upload Support

## Context

Users need to attach plain-text files (email headers, log excerpts, threat intel reports) to Neo conversations, but `.txt` is not currently an accepted file type. The 4,000-character message limit prevents pasting large text content directly. TXT files should be inlined into the conversation wrapped in XML tags, similar to inline CSVs, and supported in both the web UI and Teams channels.

A complication: `ACCEPTED_CSV_TYPES` in `types.ts` already includes `"text/plain"` as a CSV fallback MIME type. TXT uploads must be disambiguated from CSV by file extension before entering either pipeline.

---

## Key Design Decisions

- **Inline-only, no blob storage** — TXT files are always inlined as text content blocks, never uploaded to blob storage. This avoids the complexity of reference-mode and the `query_csv` tool. A 2 MB size cap provides generous headroom for email headers and log files.
- **XML wrapper** — TXT content is wrapped in `<text_attachment filename="..." size_bytes="...">...</text_attachment>` tags, matching the CSV pattern. Prompt injection escaping (angle brackets, closing tags) is applied to the content.
- **Extension-based disambiguation** — Files with `.txt` extension are routed to the TXT pipeline regardless of MIME type. Files with `.csv` extension keep their current CSV routing. Files with ambiguous extensions and `text/plain` MIME type default to TXT (safer than crashing in csv-parse).
- **Null-byte rejection and BOM stripping** — Same defensive checks as CSV: reject binary content masquerading as text, strip UTF-8 BOM.
- **Teams support** — The Teams attachment handler already calls `buildContentBlocks()`. Adding TXT support to the content block builder gives Teams support for free.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `ACCEPTED_TXT_TYPES` set, `MAX_TXT_SIZE` constant. Remove `"text/plain"` from `ACCEPTED_CSV_TYPES` (move to TXT set). |
| `web/lib/file-validation.ts` | Add `isTxtType()` function (checks MIME + `.txt` extension). Update `isCsvType()` to exclude `.txt` files. Add TXT to `isAcceptedType()` and `validateFile()`. Skip magic bytes for TXT (same as CSV). |
| `web/lib/txt-content-blocks.ts` (new) | Create `buildTxtBlock()` function: validates content (null-byte check, BOM strip, empty check), escapes for prompt safety, wraps in `<text_attachment>` XML tags. |
| `web/lib/content-blocks.ts` | Update `buildMediaBlocks()` to skip TXT files (same as CSV skip). Update `buildContentBlocks()` to handle TXT files by calling `buildTxtBlock()`. |
| `web/lib/csv-content-blocks.ts` | Update `composeUserContent()` to accept TXT blocks alongside CSV blocks in the content ordering. |
| `web/app/api/agent/route.ts` | In `handleAgentRequest()`, add a third file category alongside media and CSV: TXT files. Process TXT files through `buildTxtBlock()` and add to the content blocks. |
| `web/app/api/teams/messages/route.ts` | No code change needed — Teams uses `buildContentBlocks()` which will handle TXT after the content-blocks.ts update. Verify the Teams CDN MIME type whitelist passes `text/plain`. |
| `web/hooks/useFileUpload.ts` | Add TXT to `isAcceptedFile()`, `isCsvFile()` exclusion, `maxSizeForFile()`, and update the error message to include TXT. |
| `web/components/ChatInterface/ChatInterface.tsx` | Add `text/plain,.txt` to the file input `accept` attribute. |
| `web/components/FileAttachmentBar/FileAttachmentBar.tsx` | No change needed — non-image files already show a document icon. |
| `test/txt-upload.test.js` (new) | Tests for TXT validation, null-byte rejection, BOM stripping, content block formatting, and disambiguation from CSV. |

---

## Implementation Steps

### 1. Add TXT type constants to types.ts

- Add a new `ACCEPTED_TXT_TYPES` set containing `"text/plain"`
- Remove `"text/plain"` from `ACCEPTED_CSV_TYPES` — this is critical to prevent TXT files from entering the CSV pipeline
- Add `MAX_TXT_SIZE = 2 * 1024 * 1024` (2 MB)
- Export all new constants

### 2. Update file-validation.ts with TXT support

- Add `isTxtType(mimetype: string, filename?: string): boolean` — returns true if MIME is `text/plain` OR extension is `.txt`. Explicitly returns false if extension is `.csv` (disambiguation).
- Update `isCsvType()` — add an early return `false` if the filename ends in `.txt`, preventing overlap
- Update `isAcceptedType()` — add `isTxtType()` to the union
- Update `validateFile()` — add a size check branch for TXT files using `MAX_TXT_SIZE`
- Update `validateMagicBytes()` — add `isTxtType()` bypass (plain text has no magic bytes), same pattern as CSV
- Update the error message in `validateFile()` to include "TXT" in the accepted types list

### 3. Create txt-content-blocks.ts

- Create a new file `web/lib/txt-content-blocks.ts`
- Implement `validateAndPrepareTxt(buffer: Buffer): { text: string } | { error: string }`:
  - Check for null bytes (reject binary content)
  - Decode buffer as UTF-8
  - Strip BOM if present
  - Trim whitespace
  - Reject if empty after trimming
  - Return the cleaned text
- Implement `buildTxtBlock(filename: string, buffer: Buffer): TextBlockParam`:
  - Call `validateAndPrepareTxt()` — throw on error
  - Escape the text content: neutralize `</text_attachment` closing tags and angle brackets, same pattern as `escapeText()` in csv-content-blocks.ts
  - Escape the filename for safe XML attribute embedding
  - Wrap in `<text_attachment filename="..." size_bytes="...">` tags
  - Add an end sentinel `<!-- end_of_text_data -->`
  - Return as a `TextBlockParam` (type: "text")

### 4. Update content-blocks.ts to handle TXT

- Import `isTxtType` from file-validation and `buildTxtBlock` from txt-content-blocks
- In `buildMediaBlocks()`, add a skip condition for TXT files (same as the existing CSV skip)
- In `buildContentBlocks()`, detect TXT files in the attachments, build their blocks via `buildTxtBlock()`, and include them in the content array. TXT blocks should appear after media blocks and before the user text, matching CSV ordering.

### 5. Update csv-content-blocks.ts composeUserContent()

- Update the `composeUserContent()` function signature to accept an optional `txtBlocks` parameter alongside `csvBlocks`
- Include TXT blocks in the content array between media blocks and CSV blocks (or alongside CSVs — both are text-based attachments)

### 6. Update the agent route handler

- In `handleAgentRequest()` in `web/app/api/agent/route.ts`, add TXT file detection alongside the existing media/CSV split
- After the existing `for` loop that splits files into `csvFiles` and `mediaFiles`, add a condition: if `isTxtType(file.mimetype, file.filename)`, push to a new `txtFiles` array
- Process each TXT file through `buildTxtBlock()` and collect the resulting blocks
- Pass TXT blocks to `composeUserContent()` alongside CSV blocks
- For the persisted content, include TXT filename references (e.g., `[Attached: filename.txt]`)

### 7. Update the client-side hook and UI

- In `useFileUpload.ts`:
  - Import `ACCEPTED_TXT_TYPES` and `MAX_TXT_SIZE` from types (or add a local check)
  - Update `isAcceptedFile()` to accept TXT types
  - Update `isCsvFile()` to exclude `.txt` files (same disambiguation as server-side)
  - Update `maxSizeForFile()` to return `MAX_TXT_SIZE` for TXT files
  - Update the error message string to include "TXT"
- In `ChatInterface.tsx`:
  - Add `text/plain,.txt` to the file input `accept` attribute string

### 8. Write tests

- Create `test/txt-upload.test.js` using `node:test` and `node:assert/strict` (matching project convention)
- Test `isTxtType()`: accepts `text/plain`, accepts `.txt` extension, rejects `.csv` extension with `text/plain` MIME
- Test disambiguation: a file named `data.csv` with `text/plain` MIME routes to CSV, not TXT
- Test null-byte rejection: buffer with `\x00` byte is rejected
- Test BOM stripping: buffer starting with `\xEF\xBB\xBF` has BOM removed
- Test empty file rejection: whitespace-only buffer is rejected
- Test content block formatting: output contains `<text_attachment` opening tag, filename attribute, end sentinel
- Test size validation: file exceeding 2 MB is rejected by `validateFile()`

---

## Verification

1. Upload a `.txt` file via the web chat paper-clip icon — content should appear in Claude's response context
2. Upload a `.csv` file — should still route through CSV pipeline as before (no regression)
3. Upload a large (>2 MB) TXT file — should be rejected with a clear error
4. Upload a binary file renamed to `.txt` — should be rejected
5. Paste email headers as a `.txt` attachment in Teams — should work via the Teams bot
6. Run tests: `node --test test/txt-upload.test.js`
