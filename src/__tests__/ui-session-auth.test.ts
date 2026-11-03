/**
 * Web UI sign-in with MERIDIAN_API_KEY: the key is traded once for an
 * HttpOnly session cookie that the gated pages and routes accept.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { installLoggerMock } from "./loggerMock"

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

const { createProxyServer } = await import("../proxy/server")
const { hasValidUiSession, issueUiSession, resetUiSessions, UI_SESSION_TTL_MS } = await import("../proxy/auth")

const KEY = "test-key-0123456789"
let savedKey: string | undefined

beforeEach(() => {
  savedKey = process.env.MERIDIAN_API_KEY
  process.env.MERIDIAN_API_KEY = KEY
  resetUiSessions()
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.MERIDIAN_API_KEY
  else process.env.MERIDIAN_API_KEY = savedKey
  resetUiSessions()
})

const app = () => createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

async function signIn(key: string) {
  return app().fetch(new Request("http://localhost/ui/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  }))
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!
}

describe("web UI sign-in", () => {
  test("a browser opening a gated page is sent to sign in", async () => {
    const response = await app().fetch(new Request("http://localhost/profiles?x=1", { headers: { Accept: "text/html" } }))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/ui/login?next=%2Fprofiles%3Fx%3D1")
  })

  test("API calls still get a 401", async () => {
    const response = await app().fetch(new Request("http://localhost/profiles/list"))
    expect(response.status).toBe(401)
  })

  test("the landing page sends a browser to sign in", async () => {
    const response = await app().fetch(new Request("http://localhost/", { headers: { Accept: "text/html" } }))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/ui/login")
  })

  test("a wrong key gets no session", async () => {
    const response = await signIn("wrong")
    expect(response.status).toBe(401)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  test("the right key yields an HttpOnly, SameSite=Strict cookie the gated routes accept", async () => {
    const response = await signIn(KEY)
    expect(response.status).toBe(200)
    const setCookie = response.headers.get("set-cookie")!
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    expect(setCookie).not.toContain(KEY)

    const listed = await app().fetch(new Request("http://localhost/profiles/list", { headers: { Cookie: cookieOf(response) } }))
    expect(listed.status).toBe(200)
    const session = await (await app().fetch(new Request("http://localhost/ui/session", { headers: { Cookie: cookieOf(response) } }))).json()
    expect(session).toEqual({ required: true, signedIn: true })
  })

  test("a wrong explicit key is refused even alongside a session", async () => {
    const cookie = cookieOf(await signIn(KEY))
    const response = await app().fetch(new Request("http://localhost/profiles/list", { headers: { Cookie: cookie, "x-api-key": "wrong" } }))
    expect(response.status).toBe(401)
  })

  test("sign-out ends the session", async () => {
    const cookie = cookieOf(await signIn(KEY))
    await app().fetch(new Request("http://localhost/ui/logout", { method: "POST", headers: { Cookie: cookie } }))
    const listed = await app().fetch(new Request("http://localhost/profiles/list", { headers: { Cookie: cookie } }))
    expect(listed.status).toBe(401)
  })

  test("a cross-site page cannot sign in", async () => {
    const response = await app().fetch(new Request("http://localhost/ui/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ key: KEY }),
    }))
    expect(response.status).toBe(403)
  })

  test("sessions expire, and changing the key revokes them", () => {
    const token = issueUiSession(1_000)
    const cookie = `meridian_ui_session=${token}`
    expect(hasValidUiSession(cookie, 1_000 + UI_SESSION_TTL_MS - 1)).toBe(true)
    expect(hasValidUiSession(cookie, 1_000 + UI_SESSION_TTL_MS)).toBe(false)

    const live = `meridian_ui_session=${issueUiSession()}`
    process.env.MERIDIAN_API_KEY = "rotated-key"
    expect(hasValidUiSession(live)).toBe(false)
  })

  test("without a key the UI stays open and sign-in is not offered", async () => {
    delete process.env.MERIDIAN_API_KEY
    const page = await app().fetch(new Request("http://localhost/ui/login", { headers: { Accept: "text/html" } }))
    expect(page.status).toBe(303)
    expect((await app().fetch(new Request("http://localhost/profiles/list"))).status).toBe(200)
  })
})
