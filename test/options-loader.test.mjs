/**
 * Tests for option normalization and the koffi resolution chain.
 *
 * Neither module touches the platform, but both decide whether the plugin runs
 * at all, so each documented field and each fallback path is pinned here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, resolveOptions } from '../src/options.mjs'
import { koffiCandidates, loadKoffi } from '../src/koffi-loader.mjs'

test('an absent config yields the defaults', () => {
  for (const input of [undefined, null]) {
    const { options, problems } = resolveOptions(input)
    assert.deepEqual(options, { ...DEFAULTS })
    assert.deepEqual(problems, [])
  }
})

test('documented values survive normalization', () => {
  const { options, problems } = resolveOptions({
    enabled: false,
    flashCaption: false,
    onlyWhenUnfocused: false,
    maxFlashSeconds: 0,
    ignoreInterrupted: false,
    ignoreSubagent: false,
    flashTimeout: 250,
    flashCount: 9,
    pollIntervalMs: 500,
    allowTestFlash: false,
  })

  assert.deepEqual(problems, [])
  assert.equal(options.enabled, false)
  assert.equal(options.flashCaption, false)
  assert.equal(options.onlyWhenUnfocused, false)
  assert.equal(options.maxFlashSeconds, 0)
  assert.equal(options.ignoreInterrupted, false)
  assert.equal(options.ignoreSubagent, false)
  assert.equal(options.flashTimeout, 250)
  assert.equal(options.flashCount, 9)
  assert.equal(options.pollIntervalMs, 500)
  assert.equal(options.allowTestFlash, false)
})

test('a wrong type is reported and replaced, not accepted', () => {
  const { options, problems } = resolveOptions({
    enabled: 'yes',
    flashCaption: 1,
    maxFlashSeconds: -1,
    flashCount: 2.5,
    pollIntervalMs: 10,
  })

  assert.equal(options.enabled, DEFAULTS.enabled)
  assert.equal(options.flashCaption, DEFAULTS.flashCaption)
  assert.equal(options.maxFlashSeconds, DEFAULTS.maxFlashSeconds)
  assert.equal(options.flashCount, DEFAULTS.flashCount)
  assert.equal(options.pollIntervalMs, DEFAULTS.pollIntervalMs)
  assert.equal(problems.length, 5)
  assert.match(problems.join('\n'), /enabled must be a boolean/)
  assert.match(problems.join('\n'), /maxFlashSeconds must be an integer in \[0, 86400\]/)
})

test('unknown keys are reported and never reach the runtime', () => {
  const { options, problems } = resolveOptions({ flashEverything: true })

  assert.equal(Object.hasOwn(options, 'flashEverything'), false)
  assert.match(problems.join('\n'), /unknown option "flashEverything"/)
})

test('a non-mapping config degrades to defaults with one problem', () => {
  const array = resolveOptions([1, 2])
  assert.equal(array.problems.length, 1)
  assert.deepEqual(array.options, { ...DEFAULTS })

  const scalar = resolveOptions('on')
  assert.equal(scalar.problems.length, 1)
  assert.deepEqual(scalar.options, { ...DEFAULTS })
})

test('the plugin copy of koffi is tried first', () => {
  // koffi is a declared dependency, so the ordinary resolution is what works for
  // anyone installing from npm or a repository. The anchors exist only for a
  // `link:`/`file:` install that has no node_modules of its own.
  const candidates = koffiCandidates({
    resourcesPath: 'D:\DSH\resources',
    execPath: 'D:\DSH\[DSH].exe',
    argv: ['electron.exe', 'D:\DSH\resources\app.asar\dsh\host.js'],
    profileDir: 'C:\Users\me\.dsh\profiles\desktop',
    home: 'C:\Users\me',
  })

  assert.equal(candidates[0].label, 'plugin')
  assert.equal(candidates[0].specifier, 'koffi')
  assert.equal(candidates[0].anchor, undefined, 'resolved from this file, not an anchor')
})

test('the deployment anchors remain as fallbacks, in order', () => {
  const candidates = koffiCandidates({
    resourcesPath: 'D:\DSH\resources',
    execPath: 'D:\DSH\[DSH].exe',
    argv: ['electron.exe', 'D:\DSH\resources\app.asar\dsh\host.js'],
    profileDir: 'C:\Users\me\.dsh\profiles\desktop',
    home: 'C:\Users\me',
  })

  assert.deepEqual(
    candidates.slice(1, 4).map((candidate) => candidate.label),
    ['host-entry', 'app.asar', 'exec-dir'],
  )
  assert.ok(candidates.some((candidate) => candidate.label === 'profile'))
  assert.ok(candidates.some((candidate) => candidate.label === 'dsh-home'))
})

test('a candidate without an entry script still starts at the plugin copy', () => {
  const candidates = koffiCandidates({
    resourcesPath: 'D:\DSH\resources',
    argv: ['electron.exe'],
    profileDir: undefined,
    home: 'C:\Users\me',
  })

  assert.equal(candidates[0].label, 'plugin')
  assert.equal(candidates[1].label, 'app.asar')
})

test('the first working candidate wins', () => {
  const tried = []
  const result = loadKoffi({
    candidates: [
      { label: 'a', specifier: 'koffi' },
      { label: 'b', specifier: 'koffi' },
    ],
    requireModule: (candidate) => {
      tried.push(candidate.label)
      if (candidate.label === 'a') throw new Error('MODULE_NOT_FOUND')
      return { version: '3.3.2' }
    },
  })

  assert.deepEqual(tried, ['a', 'b'])
  assert.equal(result.label, 'b')
  assert.equal(result.koffi.version, '3.3.2')
  assert.equal(result.failures.length, 1)
})

test('total failure returns undefined and reports every attempt', () => {
  const misses = []
  const result = loadKoffi({
    candidates: [{ label: 'a', specifier: 'x' }, { label: 'b', specifier: 'y' }],
    requireModule: () => { throw new Error('nope\nsecond line') },
    onMiss: (failures) => misses.push(...failures),
  })

  assert.equal(result.koffi, undefined)
  assert.equal(result.label, undefined)
  assert.equal(misses.length, 2)
  assert.match(misses[0], /^a: Error: nope$/)
  assert.equal(result.failures.length, 2)
})

test('an empty module is treated as a miss, not a success', () => {
  const result = loadKoffi({
    candidates: [{ label: 'a', specifier: 'x' }],
    requireModule: () => undefined,
  })

  assert.equal(result.koffi, undefined)
  assert.match(result.failures[0], /a: empty/)
})
