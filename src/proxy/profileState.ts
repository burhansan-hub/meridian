/**
 * Taking a Claude profile out of service and putting it back, and removing
 * it — the edits to profiles.json shared by the CLI and the profiles page.
 *
 * Each runs under the profile configuration writer lock and publishes a
 * complete snapshot (profileConfigStore.ts), so a concurrent sign-in or
 * rename never loses its own write. Leaf module: no server/session imports.
 */
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { publishProfileConfig, readProfileConfigForUpdate } from "./profileConfigStore"
import type { ProfileConfig } from "./profiles"

export type ProfileEditResult =
  | { ok: true; profile: ProfileConfig }
  | { ok: false; error: string }

/**
 * Pure: the directories that go with a removed profile. Browser-login
 * profiles drop their explicit `claudeConfigDir` (provided it lives under
 * `profilesDir`); oauth-token profiles drop the pinned isolation dir at
 * `profilesDir/<id>` (created by the SDK during use, not stored on the
 * profile itself). A directory outside `profilesDir` was the operator's
 * before Meridian knew it and is left alone.
 */
export function dirsToRemoveOnProfileRemove(profile: ProfileConfig, profilesDir: string): string[] {
  const dirs: string[] = []
  if (profile.claudeConfigDir?.startsWith(profilesDir)) {
    dirs.push(profile.claudeConfigDir)
  }
  if (profile.oauthToken || profile.type === "oauth-token") {
    const isolationDir = join(profilesDir, profile.id)
    if (!dirs.includes(isolationDir)) dirs.push(isolationDir)
  }
  return dirs
}

/** Call under the writer lock. */
export function setProfileDisabledLocked(file: string, id: string, disabled: boolean): ProfileEditResult {
  const profiles = readProfileConfigForUpdate(file)
  const index = profiles.findIndex(p => p.id === id)
  if (index === -1) return { ok: false, error: `Profile "${id}" not found.` }
  const { disabled: _previous, ...rest } = profiles[index]!
  const profile: ProfileConfig = disabled ? { ...rest, disabled: true } : rest
  profiles[index] = profile
  publishProfileConfig(file, profiles)
  return { ok: true, profile }
}

/**
 * Call under the writer lock. The entry is published away before its
 * credentials are deleted, so no reader can resolve a profile whose
 * directory is already gone.
 */
export function removeProfileLocked(file: string, id: string, profilesDir: string): ProfileEditResult {
  const profiles = readProfileConfigForUpdate(file)
  const index = profiles.findIndex(p => p.id === id)
  if (index === -1) return { ok: false, error: `Profile "${id}" not found.` }
  const [profile] = profiles.splice(index, 1)
  publishProfileConfig(file, profiles)
  for (const dir of dirsToRemoveOnProfileRemove(profile!, profilesDir)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  return { ok: true, profile: profile! }
}
