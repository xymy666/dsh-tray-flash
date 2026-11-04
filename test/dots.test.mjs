/**
 * Tests for the dot tracker.
 *
 * The interesting behaviour is not the counting — it is the two edges that would
 * otherwise produce a flash nobody can stop: the main session never earns a real
 * dot, and a Client that disappears must read as *unknown* rather than *clear*.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createDots, DOT_KINDS, STATUS_ABSENT, STATUS_LIVE, STATUS_STALE } from '../src/dots.mjs'

/**
 * Build a tracker with a controllable clock.
 *
 * @param overrides - option overrides.
 * @returns the tracker and its harness.
 */
function harness(overrides = {}) {
  let clock = 1_000
  const warnings = []
  const dots = createDots({
    staleSeconds: 60,
    now: () => clock,
    logger: { debug: () => {}, warn: (line) => warnings.push(line) },
    ...overrides,
  })
  return {
    dots,
    warnings,
    advance(ms) {
      clock += ms
    },
  }
}

test('a fresh tracker has never heard from the Client', () => {
  const h = harness()
  assert.equal(h.dots.status(), STATUS_ABSENT)
  assert.equal(h.dots.hasDots(), undefined, 'unknown, not clear')
  assert.equal(h.dots.total(), 0)
})

test('a report makes the tracker live', () => {
  const h = harness()
  h.dots.update({ counts: { unread: 2 } })

  assert.equal(h.dots.status(), STATUS_LIVE)
  assert.equal(h.dots.total(), 2)
  assert.equal(h.dots.hasDots(), true)
})

test('all counts zero means clear', () => {
  const h = harness()
  h.dots.update({ counts: { approval: 0, question: 0, unread: 0 } })

  assert.equal(h.dots.hasDots(), false)
})

test('every dot kind adds up', () => {
  const h = harness()
  h.dots.update({ counts: { approval: 1, question: 2, unread: 3 } })

  assert.equal(h.dots.total(), 6)
  assert.deepEqual(DOT_KINDS, ['approval', 'question', 'unread'])
})

test('nonsense counts are read as zero instead of poisoning the total', () => {
  const h = harness()
  h.dots.update({ counts: { approval: -4, question: 'two', unread: Number.NaN } })

  assert.equal(h.dots.total(), 0)
  assert.equal(h.dots.hasDots(), false)
})

test('a missing report body does not throw', () => {
  const h = harness()
  assert.doesNotThrow(() => h.dots.update(undefined))
  assert.equal(h.dots.total(), 0)
})

test('a quiet Client goes stale, and stale means unknown', () => {
  const h = harness({ staleSeconds: 10 })
  h.dots.update({ counts: { unread: 1 } })
  assert.equal(h.dots.hasDots(), true)

  h.advance(11_000)

  assert.equal(h.dots.status(), STATUS_STALE)
  assert.equal(h.dots.hasDots(), undefined, 'a dead Client must not answer "clear"')
})

test('a recovered Client becomes live again without losing its dots', () => {
  const h = harness({ staleSeconds: 10 })
  h.dots.update({ counts: { unread: 1 } })
  h.advance(11_000)
  h.dots.invalidate()
  assert.equal(h.dots.status(), STATUS_STALE)

  h.dots.update({ counts: { unread: 1 } })

  assert.equal(h.dots.status(), STATUS_LIVE)
  assert.equal(h.dots.total(), 1)
})

test('the stale warning fires once, not once per poll', () => {
  const h = harness({ staleSeconds: 10 })
  h.dots.update({ counts: {} })
  h.advance(11_000)

  for (let index = 0; index < 20; index += 1) h.dots.warnIfStale()

  assert.equal(h.warnings.length, 1)
})

test('the main session raises a virtual dot that counts', () => {
  const h = harness()
  h.dots.update({ counts: {} })

  assert.equal(h.dots.noteTurnEnd('main-1', true), true)

  assert.equal(h.dots.total(), 1)
  assert.equal(h.dots.hasDots(), true)
  assert.equal(h.dots.mainPending(), true)
  assert.equal(h.dots.snapshot().mainSessionId, 'main-1')
})

test('a background session does not get a virtual dot', () => {
  const h = harness()
  const raised = h.dots.noteTurnEnd('bg-1', false)

  assert.equal(raised, false, 'the Client already gives it a real dot')
  assert.equal(h.dots.total(), 0)
})

test('the virtual dot can be turned off entirely', () => {
  const h = harness({ virtualMain: false })
  assert.equal(h.dots.noteTurnEnd('main-1', true), false)
  assert.equal(h.dots.total(), 0)
})

test('focusing the window clears the virtual dot', () => {
  const h = harness()
  h.dots.noteTurnEnd('main-1', true)

  assert.equal(h.dots.noteFocused(), true)
  assert.equal(h.dots.total(), 0)
  assert.equal(h.dots.mainPending(), false)
})

test('focusing again is a harmless no-op', () => {
  const h = harness()
  assert.equal(h.dots.noteFocused(), false)
})

test('clearing drops real and virtual dots together', () => {
  const h = harness()
  h.dots.update({ counts: { approval: 1, unread: 2 } })
  h.dots.noteTurnEnd('main-1', true)

  h.dots.clear()

  assert.equal(h.dots.total(), 0)
  assert.equal(h.dots.hasDots(), false)
  assert.equal(h.dots.mainPending(), false)
})

test('a virtual dot survives a Client restart', () => {
  // The Client reloading must not silently answer the main-session turn.
  const h = harness()
  h.dots.noteTurnEnd('main-1', true)
  h.dots.update({ counts: {} })

  assert.equal(h.dots.total(), 1)
  assert.equal(h.dots.mainPending(), true)
})

test('the snapshot is a plain object the route can serialize', () => {
  const h = harness()
  h.dots.update({ counts: { unread: 1 } })
  h.dots.noteTurnEnd('main-1', true)

  const snapshot = h.dots.snapshot()
  assert.doesNotThrow(() => JSON.stringify(snapshot))
  assert.equal(snapshot.total, 2)
  assert.equal(snapshot.status, STATUS_LIVE)
  assert.deepEqual(snapshot.counts, { approval: 0, question: 0, unread: 1 })
})
