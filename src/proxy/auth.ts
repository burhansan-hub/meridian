/**
 * Optional API key authentication middleware.
 *
 * When MERIDIAN_API_KEY is set, requests to protected routes must include
 * a matching key via `x-api-key` header or `Authorization: Bearer` header.
 * When unset, all routes are open (default behavior, backward compatible).
 *
 * A browser cannot attach the key to a navigation, so the web UI trades it
 * once at /ui/login for an HttpOnly, SameSite=Strict session cookie, which
 * protected routes also accept. Sessions live in this process only: a
 * restart or a key change signs every browser out.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"

function getConfiguredKey(): string | undefined {
  return process.env.MERIDIAN_API_KEY || undefined
}

/**
 * Whether API key authentication is enabled.
 * True when MERIDIAN_API_KEY is set to a non-empty value.
 */
export function authEnabled(): boolean {
  return Boolean(getConfiguredKey())
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Hashes both values to ensure equal-length comparison regardless of input.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", "meridian").update(a).digest()
  const hashB = createHmac("sha256", "meridian").update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/** Shared by the Hono default backend and standard-Request runtime backends. */
export function hasValidApiKey(headers: Headers): boolean {
  const key = getConfiguredKey()
  if (!key) return true
  const authorization = headers.get("authorization")
  const provided = headers.get("x-api-key") || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined)
  return Boolean(provided && safeCompare(provided, key))
}

/**
 * Extract the API key from the request.
 * Checks x-api-key header first, then Authorization: Bearer.
 */
function extractKey(c: Context): string | undefined {
  const apiKey = c.req.header("x-api-key")
  if (apiKey) return apiKey

  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  return undefined
}

/** True when `provided` is the configured key (and a key is configured). */
export function isConfiguredApiKey(provided: string): boolean {
  const key = getConfiguredKey()
  return Boolean(key && provided && safeCompare(provided, key))
}

export const UI_SESSION_COOKIE = "meridian_ui_session"
export const UI_SESSION_TTL_MS = 12 * 60 * 60_000

/** token -> { expiry, the key it was issued under } */
const uiSessions = new Map<string, { expiresAt: number; keyDigest: string }>()

function keyDigest(key: string): string {
  return createHmac("sha256", "meridian-ui-session").update(key).digest("hex")
}

/** Mint a browser session for the configured key. Call only after checking the key. */
export function issueUiSession(now: number = Date.now()): string {
  const key = getConfiguredKey()
  if (!key) throw new Error("No API key is configured")
  for (const [token, session] of uiSessions) if (session.expiresAt <= now) uiSessions.delete(token)
  const token = randomBytes(32).toString("hex")
  uiSessions.set(token, { expiresAt: now + UI_SESSION_TTL_MS, keyDigest: keyDigest(key) })
  return token
}

export function revokeUiSession(token: string | undefined): void {
  if (token) uiSessions.delete(token)
}

/** Clear every session — for testing only. */
export function resetUiSessions(): void {
  uiSessions.clear()
}

export function uiSessionToken(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === UI_SESSION_COOKIE) return part.slice(eq + 1).trim() || undefined
  }
  return undefined
}

/**
 * A live session issued under the key configured now. Changing the key
 * revokes every session issued under the old one, without a restart.
 */
export function hasValidUiSession(cookieHeader: string | undefined, now: number = Date.now()): boolean {
  const key = getConfiguredKey()
  const token = uiSessionToken(cookieHeader)
  if (!key || !token) return false
  const session = uiSessions.get(token)
  if (!session) return false
  if (session.expiresAt <= now || session.keyDigest !== keyDigest(key)) {
    uiSessions.delete(token)
    return false
  }
  return true
}

/**
 * Set-Cookie value for a session. Path=/ because the UI's pages and the
 * routes they call share no narrower prefix. `Secure` follows the scheme the
 * browser used, including behind a TLS-terminating proxy.
 */
export function uiSessionCookie(token: string, secure: boolean, maxAgeMs: number = UI_SESSION_TTL_MS): string {
  return `${UI_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`
}

/** A page load in a browser, as opposed to an API or fetch call. */
function isBrowserNavigation(c: Context): boolean {
  return c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")
}

/**
 * Hono middleware that rejects requests without a valid API key or UI
 * session. A browser opening a page is sent to /ui/login instead of a JSON
 * 401. No-op when MERIDIAN_API_KEY is not set.
 */
export async function requireAuth(c: Context, next: Next) {
  const key = getConfiguredKey()
  if (!key) return next()

  const provided = extractKey(c)
  if (provided && safeCompare(provided, key)) return next()
  // An explicit but wrong key is refused even with a live session: a caller
  // that sends a key means to be judged by it.
  if (!provided && hasValidUiSession(c.req.header("cookie"))) return next()

  if (!provided && isBrowserNavigation(c)) {
    const url = new URL(c.req.url)
    return c.redirect(`/ui/login?next=${encodeURIComponent(url.pathname + url.search)}`, 303)
  }
  return c.json({
    type: "error",
    error: {
      type: "authentication_error",
      message: "Invalid or missing API key",
    },
  }, 401)
}
