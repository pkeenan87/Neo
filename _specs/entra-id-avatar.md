# Spec for Entra ID Avatar

branch: claude/feature/entra-id-avatar

## Summary

The web UI currently displays a generic Lucide `<User />` icon as the user's avatar in the bottom-left sidebar footer. Since users authenticate via Microsoft Entra ID, their profile photo is available through the Microsoft Graph API (`/v1.0/me/photo/$value`). This feature fetches the user's Entra ID profile photo during authentication and displays it as the avatar image, falling back to the existing icon when no photo is available.

## Functional requirements

- On login via Entra ID, fetch the user's profile photo from Microsoft Graph and make it available in the NextAuth session
- Display the profile photo as a circular avatar image in the sidebar footer (bottom-left), replacing the generic `<User />` icon
- Fall back to the existing `<User />` icon when the profile photo is unavailable (e.g., no photo set in Entra ID, Graph API error, or non-Entra auth)
- The avatar image should be the same dimensions and shape as the current icon placeholder (2rem circular)
- The photo should be cached in the session/token so it is not re-fetched on every page load
- The photo data should flow through the existing layout data pipeline: server layout → context provider → ChatInterface component

## Possible Edge Cases

- User has no profile photo set in Entra ID — should show the fallback icon
- Microsoft Graph API returns an error or is unreachable during login — login should succeed with fallback icon, not fail
- Profile photo is very large — should be resized or constrained to reasonable dimensions
- User authenticates via API key (non-Entra) — should show the fallback icon since there is no Graph API access
- Session token size limit — storing a base64-encoded image in the JWT may exceed token size limits; may need to use a URL-based approach or server-side caching instead
- The photo URL expires — if using a URL approach, ensure it is refreshed appropriately

## Acceptance Criteria

- Users who have a profile photo in Entra ID see their photo as the avatar in the sidebar footer
- Users without a profile photo see the existing `<User />` icon (no broken image)
- The avatar is circular and matches the current 2rem size
- Login does not fail or slow noticeably when the photo fetch encounters an error
- The photo persists across page navigations within the same session
- The fallback icon has alt text or accessible label for screen readers
- The profile image has appropriate alt text (e.g., the user's name)

## Open Questions

- Should the photo be stored as a base64 data URL in the JWT session token, or fetched server-side and served via an API route (e.g., `/api/me/photo`)? The JWT approach is simpler but may hit size limits for large photos.
- Should we request additional Microsoft Graph scopes (e.g., `User.Read` already covers `/me/photo`), or is the current scope sufficient?
- Should the avatar also appear in the chat message bubbles next to user messages, or only in the sidebar footer?

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- When a user image URL is provided, the avatar renders an `<img>` element instead of the `<User />` icon
- When no user image is provided (undefined/null), the avatar renders the fallback `<User />` icon
- The `<img>` element has appropriate alt text
- The avatar container maintains circular styling regardless of content type
