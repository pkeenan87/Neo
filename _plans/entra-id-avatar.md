# Entra ID Avatar

## Context

The web UI shows a generic `<User />` icon as the avatar in the sidebar footer and has no user avatar in chat message bubbles. Since users authenticate via Entra ID with the `User.Read` scope (which includes access to `/me/photo`), the profile photo can be fetched during login and stored as a base64 data URL in the JWT session token. This plan threads the image through the existing data pipeline (auth → layout → context → ChatInterface) and adds it to both the sidebar footer and user message bubbles.

---

## Key Design Decisions

- **Store photo as base64 data URL in the JWT.** The user confirmed JWT storage. Microsoft Graph returns small 48×48 or 96×96 thumbnails for `/me/photos/48x48/$value`, keeping the JWT size manageable. Use the smallest size (48×48) to minimize token bloat.
- **Fetch photo in the NextAuth `jwt` callback during initial sign-in.** This is the only point where the Entra ID access token is available. Use `account.access_token` to call the Graph photo endpoint.
- **Fire-and-forget failure.** If the photo fetch fails, set `token.picture` to `undefined` and the UI falls back to the `<User />` icon. Login must never fail due to a missing photo.
- **Use `next/image` for the avatar.** Provides automatic optimisation and the `alt` attribute for accessibility. Use `fill` mode with `sizes` since the avatar is a fixed small size.
- **Add avatar to user message bubbles.** Mirroring the assistant's `msgAvatarAssistant` pattern, add a `msgAvatarUser` element before user message content. This shows the profile photo (or fallback icon) next to user messages.
- **Create a reusable `UserAvatar` component.** Both the sidebar footer and message bubbles need the same avatar logic (image vs fallback icon), so a shared component avoids duplication.

---

## Files to Change

| File | Change |
|------|--------|
| `web/auth.ts` | In the `jwt` callback, fetch the user's 48×48 profile photo from Microsoft Graph on initial Entra ID sign-in and store it as `token.picture` (base64 data URL) |
| `web/types/next-auth.d.ts` | Add `picture?: string` to the `JWT` interface and `image?: string` to the `User` interface (NextAuth maps `token.picture` → `session.user.image` by default) |
| `web/lib/get-auth-context.ts` | Add `userImage` field to the `AuthContext` interface; read `user.image` from the session |
| `web/app/chat/layout.tsx` | Pass `userImage` from `authCtx` to `ChatLayoutClient` |
| `web/app/chat/ChatLayoutClient.tsx` | Add `userImage` to props interface; pass it through context |
| `web/app/chat/ChatLayoutContext.tsx` | Add `userImage` to `ChatLayoutValue` interface and context default |
| `web/app/chat/ChatPageClient.tsx` | Read `userImage` from context; pass it to `ChatInterface` |
| `web/components/UserAvatar/UserAvatar.tsx` | New component — renders a circular `next/image` when `src` is provided, otherwise renders the Lucide `<User />` icon fallback |
| `web/components/UserAvatar/UserAvatar.module.css` | New CSS module — circular container, image fill, fallback styling |
| `web/components/UserAvatar/index.ts` | Barrel export |
| `web/components/index.ts` | Add `UserAvatar` barrel export |
| `web/components/ChatInterface/ChatInterface.tsx` | Add `userImage` prop; use `<UserAvatar>` in the sidebar footer avatar and add a user avatar before each user message bubble |
| `web/components/ChatInterface/ChatInterface.module.css` | Add `.msgAvatarUser` class mirroring `.msgAvatarAssistant` styling but circular |
| `test/user-avatar.test.js` | New test file for the `UserAvatar` component rendering logic |

---

## Implementation Steps

### 1. Fetch profile photo in the NextAuth JWT callback

- In `web/auth.ts`, inside the `jwt` callback's `if (account && user)` block, after the Entra ID role resolution, add a photo fetch:
  - Only run when `account.provider === "microsoft-entra-id"` and `account.access_token` exists
  - Call `https://graph.microsoft.com/v1.0/me/photos/48x48/$value` with `Authorization: Bearer ${account.access_token}` and `Accept: */*` (the endpoint returns binary image data)
  - Convert the response `ArrayBuffer` to a base64 string, then construct a data URL: `data:${contentType};base64,${base64String}`
  - Store the result as `token.picture` (NextAuth's standard field for profile images)
  - Wrap the entire fetch in a try-catch — on any failure, log a warning and set `token.picture = undefined`

### 2. Update NextAuth type declarations

- In `web/types/next-auth.d.ts`, add `picture?: string` to the `JWT` interface
- The `User` interface already has an `image` field in NextAuth's base types, so `session.user.image` will be populated automatically by NextAuth's default `session` callback behavior when `token.picture` is set

### 3. Pass the `session.user.image` through to the session callback

- In `web/auth.ts`, in the `session` callback, add `user.image = token.picture` alongside the existing `user.role`, `user.authProvider`, and `user.oid` assignments

### 4. Add `userImage` to the auth context

- In `web/lib/get-auth-context.ts`, add `userImage?: string` to the `AuthContext` interface
- In the `getAuthContext` function, read `user.image` from the session and include it in the returned object
- For the dev bypass path, set `userImage` to `undefined`

### 5. Thread `userImage` through the layout pipeline

- In `web/app/chat/layout.tsx`: destructure `userImage` from `authCtx`; pass it to `ChatLayoutClient`
- In `web/app/chat/ChatLayoutClient.tsx`: add `userImage?: string` to the props interface; include it in the context provider value
- In `web/app/chat/ChatLayoutContext.tsx`: add `userImage?: string` to the `ChatLayoutValue` interface; add `userImage: undefined` to the context default value
- In `web/app/chat/ChatPageClient.tsx`: destructure `userImage` from `useChatLayout()`; pass it to `<ChatInterface>`

### 6. Create the `UserAvatar` component

- Create `web/components/UserAvatar/UserAvatar.tsx`:
  - Props interface `UserAvatarProps`: `src?: string`, `userName?: string`, `size?: number` (default 32), `className?: string`
  - When `src` is provided: render a `next/image` with `src`, `alt={userName ?? 'User avatar'}`, `width={size}`, `height={size}`, with the circular container style
  - When `src` is not provided: render the Lucide `<User />` icon inside the circular container (matching current behavior)
  - Add `onError` handler on the `<Image>` that sets a local `hasError` state to `true`, which switches to the fallback icon (handles broken/expired data URLs)
- Create `web/components/UserAvatar/UserAvatar.module.css`:
  - `.container` class: circular (`border-radius: 9999px`), `overflow: hidden`, `display: flex`, `align-items: center`, `justify-content: center`, border and background matching the current `.avatar` class
  - `.image` class: `object-fit: cover`, `width: 100%`, `height: 100%`
  - Dark mode variant for the fallback state
- Create `web/components/UserAvatar/index.ts`: barrel export
- Add `export { UserAvatar } from './UserAvatar'` to `web/components/index.ts`

### 7. Update ChatInterface to use the UserAvatar component

- In `web/components/ChatInterface/ChatInterface.tsx`:
  - Add `userImage?: string` to `ChatInterfaceProps`
  - Import `UserAvatar` from `@/components`
  - Replace the sidebar footer avatar (`<div className={styles.avatar}><User ... /></div>`) with `<UserAvatar src={userImage} userName={userName} size={32} className={styles.avatar} />`
  - In the message rendering loop, add a user avatar before user message content: when `msg.role === 'user'`, render `<div className={styles.msgAvatarUser}><UserAvatar src={userImage} userName={userName} size={32} /></div>` before the `msgContentUser` div. Mirror the same pattern used for assistant messages (`msgAvatarAssistant`)

### 8. Add CSS for user message avatar

- In `web/components/ChatInterface/ChatInterface.module.css`, add `.msgAvatarUser` class near the existing `.msgAvatarAssistant`:
  - Same dimensions as `msgAvatarAssistant` (2.5rem × 2.5rem) but with `border-radius: 9999px` (circular, not rounded-square)
  - Flex shrink 0 to prevent compression
  - Aligned to top of the message row

### 9. Create test file

- Create `test/user-avatar.test.js` using `node:test` (matching existing test convention in the repo)
- Since the component uses React and `next/image`, tests should focus on the pure logic rather than full rendering. Test the component's exported behavior:
  - When `src` is provided, the component should render an element with the image source (verify via a simple check that the src prop would be used)
  - When `src` is undefined, the component should render the fallback
  - The alt text should default to "User avatar" when `userName` is not provided
  - The alt text should use `userName` when provided
- Note: Full React component testing would require additional dependencies (jsdom, testing-library). Keep tests lightweight and focused on the logic.

---

## Verification

1. Run `cd web && npm run build` to verify TypeScript compiles and the build succeeds
2. Run `node --test test/user-avatar.test.js` for unit tests
3. Manual test — log in with an Entra ID account that has a profile photo; verify the photo appears in the sidebar footer avatar and next to user messages
4. Manual test — log in with an Entra ID account that does NOT have a profile photo; verify the `<User />` icon fallback appears
5. Manual test — use dev bypass mode (`DEV_AUTH_BYPASS=true`); verify the `<User />` icon fallback appears
6. Inspect the rendered `<img>` element and verify it has appropriate alt text
7. Test in dark mode to verify avatar styling is correct in both themes
