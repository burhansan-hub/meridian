/**
 * Balanced routing, disabled profiles and MERIDIAN_REQUIRE_PROFILE through the
 * HTTP layer, with a mocked SDK that records which profile (CLAUDE_CONFIG_DIR)
 * served each request and can hold a request open.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installModelsMock } from "./modelsMock"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { resolveMockSdkSessionId } from "./helpers"

const configDir = mkdtempSync(join(tmpdir(), "meridian-balanced-"))
process.env.MERIDIAN_CONFIG_DIR = configDir

const served: string[] = []
let hold: Promise<void> | null = null

installSdkMock(() => ({
  query: (opts: { options?: { sessionId?: string; env?: Record<string, string> } }) => {
    served.push(opts.options?.env?.CLAUDE_CONFIG_DIR ?? "default")
    const wait = hold
    return (async function* () {
      if (wait) await wait
      yield {
        type: "assistant",
        message: { type: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: resolveMockSdkSessionId(opts.options, `session-${crypto.randomUUID()}`),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "balanced-routing-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installModelsMock(() => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer } = await import("../proxy/server")
const { enableDiskProfileDiscovery, resetDiskProfileDiscovery, invalidateDiskProfileCache, resetActiveProfile } = await import("../proxy/profiles")
const { clearSessionCache } = await import("../proxy/session/cache")

const profilesFile = join(configDir, "profiles.json")
const dirOf = (id: string) => join(configDir, "profiles", id)

function writeProfiles(ids: string[], disabled: string[] = []) {
  for (const id of ids) mkdirSync(dirOf(id), { recursive: true })
  writeFileSync(profilesFile, JSON.stringify(ids.map(id => ({
    id,
    claudeConfigDir: dirOf(id),
    ...(disabled.includes(id) ? { disabled: true } : {}),
  }))))
  invalidateDiskProfileCache()
}

function message(text: string, profile?: string): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(profile ? { "x-meridian-profile": profile } : {}) },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: text }] }),
  })
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const savedEnv: Record<string, string | undefined> = {}
beforeEach(async () => {
  for (const key of ["MERIDIAN_ROUTING", "MERIDIAN_REQUIRE_PROFILE", "CLAUDE_CONFIG_DIR"]) savedEnv[key] = process.env[key]
  delete process.env.CLAUDE_CONFIG_DIR
  served.length = 0
  hold = null
  resetActiveProfile()
  enableDiskProfileDiscovery()
  await clearSessionCache()
})
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetDiskProfileDiscovery()
})

describe("balanced routing", () => {
  test("a new conversation goes to the account with the fewest requests in flight, then the one idle longest", async () => {
    process.env.MERIDIAN_ROUTING = "balanced"
    writeProfiles(["a", "b"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    let release!: () => void
    hold = new Promise<void>(resolve => { release = resolve })
    const first = app.fetch(message("first conversation"))
    // Let the first request reach the SDK and take its place on "a".
    while (served.length < 1) await new Promise(resolve => setTimeout(resolve, 5))
    hold = null
    const second = await app.fetch(message("second conversation"))
    expect(second.status).toBe(200)
    release()
    expect((await first).status).toBe(200)
    expect(served).toEqual([dirOf("a"), dirOf("b")])

    // Both idle and unmeasured: "a" started longest ago.
    const third = await app.fetch(message("third conversation"))
    expect(third.status).toBe(200)
    expect(served[2]).toBe(dirOf("a"))
  })

  test("a disabled profile takes no pool traffic", async () => {
    process.env.MERIDIAN_ROUTING = "balanced"
    writeProfiles(["a", "b", "c"], ["a"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    for (const text of ["one", "two", "three", "four"]) {
      expect((await app.fetch(message(text))).status).toBe(200)
    }
    expect(served).not.toContain(dirOf("a"))
    expect(new Set(served)).toEqual(new Set([dirOf("b"), dirOf("c")]))
  })
})

describe("profile routes", () => {
  test("disable refuses pinned requests until enabled again", async () => {
    writeProfiles(["a", "b"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    const disabled = await app.fetch(post("/profiles/disable", { profile: "a", disabled: true }))
    expect(disabled.status).toBe(200)
    expect(JSON.parse(readFileSync(profilesFile, "utf8"))[0]).toMatchObject({ id: "a", disabled: true })

    const refused = await app.fetch(message("pinned", "a"))
    expect(refused.status).toBe(403)
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("profile_disabled")

    // Unpinned work moves to the remaining profile.
    expect((await app.fetch(message("unpinned"))).status).toBe(200)
    expect(served).toEqual([dirOf("b")])

    const listed = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<{ id: string; disabled?: boolean }> }
    expect(listed.profiles.find(p => p.id === "a")?.disabled).toBe(true)

    expect((await app.fetch(post("/profiles/disable", { profile: "a", disabled: false }))).status).toBe(200)
    expect((await app.fetch(message("pinned again", "a"))).status).toBe(200)
    expect(served[1]).toBe(dirOf("a"))
  })

  test("remove deletes the profile and moves the active pointer off it", async () => {
    writeProfiles(["a", "b"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    expect((await app.fetch(post("/profiles/active", { profile: "a" }))).status).toBe(200)

    const removed = await app.fetch(post("/profiles/remove", { profile: "a" }))
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ success: true, profile: "a", activeProfile: "b", remaining: ["b"] })
    expect(JSON.parse(readFileSync(profilesFile, "utf8")).map((p: { id: string }) => p.id)).toEqual(["b"])

    expect((await app.fetch(post("/profiles/remove", { profile: "a" }))).status).toBe(404)
  })

  test("a cross-site page cannot change profiles", async () => {
    writeProfiles(["a"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const response = await app.fetch(new Request("http://localhost/profiles/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ profile: "a", disabled: true }),
    }))
    expect(response.status).toBe(403)
    expect(JSON.parse(readFileSync(profilesFile, "utf8"))[0]).not.toHaveProperty("disabled")
  })
})

describe("MERIDIAN_REQUIRE_PROFILE", () => {
  test("refuses unpinned and unknown profiles before any account is used", async () => {
    process.env.MERIDIAN_REQUIRE_PROFILE = "1"
    process.env.MERIDIAN_ROUTING = "balanced"
    writeProfiles(["a", "b"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    const unpinned = await app.fetch(message("no header"))
    expect(unpinned.status).toBe(400)
    expect((await unpinned.json() as { error: { code: string } }).error.code).toBe("profile_required")

    const unknown = await app.fetch(message("unknown", "c"))
    expect(unknown.status).toBe(404)

    expect((await app.fetch(message("known", "b"))).status).toBe(200)
    expect(served).toEqual([dirOf("b")])
  })
})

process.on("exit", () => rmSync(configDir, { recursive: true, force: true }))
