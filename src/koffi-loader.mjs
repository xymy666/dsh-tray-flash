/**
 * Locate the `koffi` FFI module from inside a Host plugin.
 *
 * `koffi` is a normal dependency of this package, so the ordinary resolution — a
 * bare `require('koffi')` from the plugin's own position — is tried first and is
 * what works for anyone who installed the plugin from npm or from a repository.
 *
 * The fallbacks exist for one real case: a plugin installed into a profile by
 * `link:` or `file:` lives *outside* the profile directory, so its own
 * `node_modules` may not exist at all and a bare require walks up its workspace
 * path and fails with MODULE_NOT_FOUND — verified against the real desktop
 * profile. The Host itself always runs inside the Electron `app.asar`, where koffi
 * ships as a dependency of `@deepseek-ai/dsh`, so those anchors are tried next.
 * They are a compatibility shim for local development, not the primary path.
 *
 * Every candidate is attempted in order. A total failure returns `undefined`
 * and logs once: an FFI-less Host is a degraded plugin, never a broken Host.
 *
 * @module dsh-tray-flash/koffi-loader
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Build the ordered list of places to resolve `koffi` from.
 *
 * @param environment - process facts to derive candidates from.
 * @returns candidate descriptors, most reliable first.
 */
export function koffiCandidates(environment = {}) {
  const {
    resourcesPath = process.resourcesPath,
    execPath = process.execPath,
    argv = process.argv,
    profileDir = process.env.DSH_PROFILE_DIR,
    home = homedir(),
  } = environment

  /** @type {{ label: string, specifier: string, anchor?: string }[]} */
  const candidates = []

  // The normal path: koffi is a declared dependency, so it sits beside this file.
  candidates.push({ label: 'plugin', specifier: 'koffi' })

  // Fallbacks for a `link:`/`file:` install, where the plugin has no own modules.
  const entry = argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    candidates.push({ label: 'host-entry', specifier: 'koffi', anchor: entry })
  }
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push({
      label: 'app.asar',
      specifier: join(resourcesPath, 'app.asar', 'dsh', 'node_modules', 'koffi'),
    })
  }
  if (typeof execPath === 'string' && execPath.length > 0) {
    candidates.push({
      label: 'exec-dir',
      specifier: join(execPath, '..', 'resources', 'app.asar', 'dsh', 'node_modules', 'koffi'),
    })
  }
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    candidates.push({ label: 'profile', specifier: 'koffi', anchor: join(profileDir, 'package.json') })
    candidates.push({ label: 'profile-sibling', specifier: join(profileDir, '..', 'node_modules', 'koffi') })
  }
  candidates.push({ label: 'dsh-home', specifier: join(home, '.dsh', 'profiles', 'node_modules', 'koffi') })

  return candidates
}

/**
 * Resolve and load `koffi`.
 *
 * @param options - overrides for the derivation inputs plus an injectable `require`.
 * @returns the loaded module, or `undefined` when every candidate failed.
 */
export function loadKoffi(options = {}) {
  const { requireModule, candidates, onMiss } = options
  const list = candidates ?? koffiCandidates(options)
  const failures = []

  for (const candidate of list) {
    try {
      const loaded = requireModule === undefined
        ? resolveWith(candidate)
        : requireModule(candidate)
      if (loaded !== undefined && loaded !== null) {
        return { koffi: loaded, label: candidate.label, failures }
      }
      failures.push(`${candidate.label}: empty`)
    } catch (error) {
      failures.push(`${candidate.label}: ${describe(error)}`)
    }
  }

  if (onMiss !== undefined) onMiss(failures)
  return { koffi: undefined, label: undefined, failures }
}

/**
 * Resolve one candidate through `createRequire`, honouring its anchor.
 *
 * @param candidate - label, specifier, and optional anchor path.
 * @returns the loaded module.
 */
function resolveWith(candidate) {
  const anchor = candidate.anchor ?? import.meta.url
  return createRequire(anchor)(candidate.specifier)
}

/**
 * Reduce an error to one short line for the failure log.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}
