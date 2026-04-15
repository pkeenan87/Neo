# Spec for TXT File Upload Support

branch: claude/feature/txt-file-upload-support

## Summary

Add `.txt` file upload support to Neo's web chat. Users need to paste long-form text content (e.g., raw email headers, log excerpts, threat intel reports) into investigations, but the 4,000-character message limit blocks this. Allowing `.txt` file attachments lets users upload text content that exceeds the message limit, using the same inline strategy as small CSVs.

## Functional Requirements

- Add `text/plain` to the accepted file types in both the client-side validation and server-side multipart parser
- TXT files should be inlined directly into the conversation as text content (similar to inline-mode CSVs), not uploaded to blob storage
- Apply a reasonable size cap (e.g., 1 MB) — large enough for email headers and log files, small enough to avoid flooding the context window
- The file picker in the web UI should accept `.txt` files alongside the existing image, PDF, and CSV types
- The error message for unsupported file types should be updated to include TXT in the list
- TXT content should be wrapped in a clear delimiter (e.g., `<text_attachment>`) so Claude can distinguish attached text from user messages
- Magic byte validation should be skipped or adjusted for `.txt` files since plain text has no magic bytes

## Possible Edge Cases

- Files with `.txt` extension but binary content (e.g., renamed executables) — should be rejected via null-byte detection, same as CSV
- Very large TXT files that would overwhelm the context window — enforce the size cap and consider a token estimate warning
- Files with unusual encodings (UTF-16, Latin-1) — decide whether to normalize to UTF-8 or reject non-UTF-8
- Empty `.txt` files — reject with a user-friendly error
- Files with no extension but `text/plain` MIME type — should be accepted
- BOM (byte order mark) at the start of UTF-8 files — strip it, matching the existing CSV behavior

## Acceptance Criteria

- Users can attach `.txt` files via the paper-clip icon in the web chat
- TXT file content is visible to Claude in the conversation and can be referenced in responses
- Files exceeding the size cap are rejected with a clear error message before upload
- The file picker shows `.txt` as an accepted type
- Binary files renamed to `.txt` are rejected
- Existing image, PDF, and CSV upload functionality is not affected

## Open Questions

- Should there be a character/token limit that triggers truncation with a warning, or should oversized files simply be rejected? Lets set it to something large, we have big txt files that contain things like email headers.
- Should TXT uploads be supported in the Teams bot channel as well, or web-only for now? yes teams as well.
- Should the content be wrapped in XML tags (like CSV) or treated as a plain text block appended to the user message? wrap it in xml tags

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Verify `text/plain` is accepted by the file type validator
- Verify files exceeding the size cap are rejected
- Verify null-byte content is rejected (binary masquerading as TXT)
- Verify BOM stripping works for UTF-8 TXT files
- Verify empty TXT files are rejected
- Verify the TXT content block is correctly formatted for the conversation
