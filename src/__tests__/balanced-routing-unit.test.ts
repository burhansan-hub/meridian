/**
 * Unit tests for balanced routing, disabled profiles and strict profile
 * resolution — pure functions plus the profiles.json edits.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyRouteKind,
  getRoutingMode,
  isPoolRouting,
  orderByLoad,
  ProfileLoad,
  ROUTING_MODES,
  type ProfileLoadReading,
} from "../proxy/routing"
import {
  enabledProfileIds,
  listProfiles,
  ProfileRefusal,
  resetActiveProfile,
  resolveProfile,
  resolveRequestProfile,
  setActiveProfile,
  type ProfileConfig,
} from "../proxy/profiles"
import { removeProfileLocked, setProfileDisabledLocked } from "../proxy/profileState"

const reading = (id: string, fields: Partial<ProfileLoadReading> = {}): ProfileLoadReading =>
  ({ id, inFlight: 0, utilization: undefined, lastStartedAt: undefined, ...fields })

describe("balanced routing mode", () => {
  test("parses, is a pool mode and is selectable", () => {
    expect(getRoutingMode("balanced")).toBe("balanced")
    expect(getRoutingMode("BALANCED")).toBe("balanced")
    expect(isPoolRouting("balanced")).toBe(true)
    expect(ROUTING_MODES).toContain("balanced")
  })

  test("attributes requests and hops to balanced", () => {
    expect(classifyRouteKind({ routingMode: "balanced" })).toBe("balanced")
    expect(classifyRouteKind({ routingMode: "balanced", priorityHop: true })).toBe("balanced-hop")
    expect(classifyRouteKind({ routingMode: "priority", priorityHop: true })).toBe("priority-hop")
  })
})

describe("orderByLoad", () => {
  test("fewest requests in flight first", () => {
    const readings = { a: reading("a", { inFlight: 2 }), b: reading("b", { inFlight: 0 }), c: reading("c", { inFlight: 1 }) }
    expect(orderByLoad(["a", "b", "c"], id => readings[id as keyof typeof readings])).toEqual(["b", "c", "a"])
  })

  test("equal load goes to the lower measured usage, unmeasured counting as unused", () => {
    const readings = { a: reading("a", { utilization: 0.6 }), b: reading("b", { utilization: 0.2 }), c: reading("c") }
    expect(orderByLoad(["a", "b", "c"], id => readings[id as keyof typeof readings])).toEqual(["c", "b", "a"])
  })

  test("then the profile idle longest, never-used first", () => {
    const readings = { a: reading("a", { lastStartedAt: 300 }), b: reading("b", { lastStartedAt: 100 }), c: reading("c") }
    expect(orderByLoad(["a", "b", "c"], id => readings[id as keyof typeof readings])).toEqual(["c", "b", "a"])
  })

  test("full ties keep the configured order", () => {
    expect(orderByLoad(["z", "y", "x"], id => reading(id))).toEqual(["z", "y", "x"])
  })
})

describe("ProfileLoad", () => {
  test("counts a request against the profile it is trying, moving with failover", () => {
    let now = 1000
    const load = new ProfileLoad(() => now)
    const first = load.track()
    const second = load.track()
    first.attempt("a")
    second.attempt("a")
    expect(load.inFlight("a")).toBe(2)
    now = 2000
    first.attempt("b")
    expect(load.inFlight("a")).toBe(1)
    expect(load.inFlight("b")).toBe(1)
    expect(load.lastStartedAt("b")).toBe(2000)
    first.end()
    first.end()
    second.end()
    expect(load.inFlight("a")).toBe(0)
    expect(load.inFlight("b")).toBe(0)
    expect(load.lastStartedAt("a")).toBe(1000)
  })

  test("ending a request that never attempted is harmless", () => {
    const load = new ProfileLoad()
    load.track().end()
    expect(load.inFlight("a")).toBe(0)
  })
})

describe("disabled profiles", () => {
  const profiles: ProfileConfig[] = [
    { id: "personal", claudeConfigDir: "/p" },
    { id: "work", claudeConfigDir: "/w", disabled: true },
    { id: "spare", claudeConfigDir: "/s" },
  ]

  beforeEach(() => resetActiveProfile())

  test("the fallback chain skips a disabled active profile", () => {
    setActiveProfile("work")
    expect(resolveProfile(profiles, undefined).id).toBe("personal")
  })

  test("the fallback chain skips a disabled first profile", () => {
    const firstDisabled: ProfileConfig[] = [{ id: "a", claudeConfigDir: "/a", disabled: true }, { id: "b", claudeConfigDir: "/b" }]
    expect(resolveProfile(firstDisabled, undefined).id).toBe("b")
  })

  test("admin paths still resolve a disabled profile by name", () => {
    expect(resolveProfile(profiles, undefined, "work").id).toBe("work")
  })

  test("a request pinned to a disabled profile is refused", () => {
    expect(() => resolveRequestProfile(profiles, undefined, "work")).toThrow(ProfileRefusal)
    try { resolveRequestProfile(profiles, undefined, "work") } catch (error) {
      expect((error as ProfileRefusal).status).toBe(403)
      expect((error as ProfileRefusal).code).toBe("profile_disabled")
    }
  })

  test("with every profile disabled a request is refused rather than served", () => {
    const allDisabled = profiles.map(p => ({ ...p, disabled: true }))
    try {
      resolveRequestProfile(allDisabled, undefined)
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as ProfileRefusal).code).toBe("no_enabled_profile")
      expect((error as ProfileRefusal).status).toBe(503)
    }
  })

  test("listing reports the flag and enabledProfileIds leaves the profile out", () => {
    expect(listProfiles(profiles, undefined).find(p => p.id === "work")?.disabled).toBe(true)
    expect(listProfiles(profiles, undefined).find(p => p.id === "personal")).not.toHaveProperty("disabled")
    expect(enabledProfileIds(profiles)).toEqual(["personal", "spare"])
  })
})

describe("MERIDIAN_REQUIRE_PROFILE", () => {
  const profiles: ProfileConfig[] = [{ id: "tenant-a", claudeConfigDir: "/a" }, { id: "tenant-b", claudeConfigDir: "/b" }]
  let saved: string | undefined

  beforeEach(() => {
    resetActiveProfile()
    saved = process.env.MERIDIAN_REQUIRE_PROFILE
    process.env.MERIDIAN_REQUIRE_PROFILE = "1"
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MERIDIAN_REQUIRE_PROFILE
    else process.env.MERIDIAN_REQUIRE_PROFILE = saved
  })

  test("a request without a profile is refused", () => {
    try {
      resolveRequestProfile(profiles, undefined)
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as ProfileRefusal).code).toBe("profile_required")
    }
  })

  test("an unknown profile is refused instead of served by the first one", () => {
    try {
      resolveRequestProfile(profiles, undefined, "tenant-c")
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as ProfileRefusal).code).toBe("unknown_profile")
      expect((error as ProfileRefusal).status).toBe(404)
    }
  })

  test("a registered profile is served", () => {
    expect(resolveRequestProfile(profiles, undefined, "tenant-b").id).toBe("tenant-b")
  })
})

describe("profiles.json edits", () => {
  let dir: string
  let file: string
  let profilesDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-profile-state-"))
    file = join(dir, "profiles.json")
    profilesDir = join(dir, "profiles")
    mkdirSync(join(profilesDir, ".add-x"), { recursive: true })
    writeFileSync(file, JSON.stringify([
      { id: "a", claudeConfigDir: join(profilesDir, ".add-x") },
      { id: "b", claudeConfigDir: "/elsewhere/b" },
    ]))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = () => JSON.parse(readFileSync(file, "utf8")) as ProfileConfig[]

  test("disable and enable round-trip without touching other fields", () => {
    expect(setProfileDisabledLocked(file, "b", true).ok).toBe(true)
    expect(read()).toEqual([
      { id: "a", claudeConfigDir: join(profilesDir, ".add-x") },
      { id: "b", claudeConfigDir: "/elsewhere/b", disabled: true },
    ])
    expect(setProfileDisabledLocked(file, "b", false).ok).toBe(true)
    expect(read()[1]).toEqual({ id: "b", claudeConfigDir: "/elsewhere/b" })
  })

  test("an unknown profile is reported, not created", () => {
    expect(setProfileDisabledLocked(file, "nope", true)).toEqual({ ok: false, error: 'Profile "nope" not found.' })
    expect(read()).toHaveLength(2)
  })

  test("remove drops the entry and the credential directory Meridian created", () => {
    expect(removeProfileLocked(file, "a", profilesDir).ok).toBe(true)
    expect(read().map(p => p.id)).toEqual(["b"])
    expect(existsSync(join(profilesDir, ".add-x"))).toBe(false)
  })

  test("remove leaves a directory outside the profiles directory alone", () => {
    const outside = join(dir, "operator-owned")
    mkdirSync(outside)
    writeFileSync(file, JSON.stringify([{ id: "c", claudeConfigDir: outside }]))
    expect(removeProfileLocked(file, "c", profilesDir).ok).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })
})
