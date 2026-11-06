/**
 * Tests for "flash until the pointer moves".
 *
 * This covers a case the dot rule cannot: the window is already in front and the
 * turn that just finished belongs to the session on screen. No dot exists for
 * that (the main session never earns one), so without this the flash ended in the
 * same tick it started and a person watching the conversation got no signal.
 *
 * The pointer becomes the acknowledgement, which is why these tests drive a fake
 * cursor position rather than a fake clock alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAttention, STOP } from '../src/attention.mjs'
import { createDots } from '../src/dots.mjs'
import { DEFAULTS } from '../src/options.mjs'

/**
 * Build a controller whose window focus, cursor and current session are drivable.
 *
 * @param options - option overrides.
 * @param behavior - `{ cursorReadable }` to simulate a port without cursor access.
 * @returns the controller and the knobs the tests turn.
 */
function harness(options = {}, behavior = {}) {
  const { cursorReadable = true } = behavior
  let clock = 1_000
  const state = {
    foreground: true,
    live: true,
    cursor: { x: 100, y: 100 },
    session: 'main-1',
  }
  const intervals = []
  const cleared = []
  const logs = []

  const port = {
    findMainWindow: () => ({ hwnd: 0x1234n, className: 'Chrome_WidgetWin_1', title: 'x — DeepSeek Harness', visible: true }),
    flash: () => 1,
    stop: () => 1,
    isLive: () => state.live,
    isForeground: () => state.foreground,
    cursorMoved: (previous, current) => previous !== undefined
      && current !== undefined
      && (previous.x !== current.x || previous.y !== current.y),
    dispose() {},
  }
  if (cursorReadable) port.cursorPosition = () => state.cursor

  const dots = createDots({
    staleSeconds: 60,
    virtualMain: true,
    now: () => clock,
    logger: { warn: (line) => logs.push(line), debug() {} },
  })

  const attention = createAttention({
    port,
    options: { ...DEFAULTS, ...options },
    pids: [4242],
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    dots,
    now: () => clock,
    setIntervalFn: (fn) => {
      const handle = { fn, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearIntervalFn: (handle) => cleared.push(handle),
  })

  return {
    attention,
    dots,
    state,
    intervals,
    cleared,
    logs,
    tick: () => intervals.at(-1)?.fn(),
    advance(ms) {
      clock += ms
    },
  }
}

/**
 * Put the harness in the state the feature exists for: the session on screen
 * finished a turn while the window already had the foreground.
 *
 * @param h - harness.
 * @returns the notify result.
 */
function finishCurrentSession(h) {
  h.dots.update({ counts: {}, mainSessionId: h.state.session })
  return h.attention.notifyTurnEnd(
    { type: 'turn/end', data: {} },
    { id: h.state.session },
    { isMain: true },
  )
}

test('a focused turn on the current session keeps flashing while the pointer is still', () => {
  const h = harness()
  assert.equal(finishCurrentSession(h).started, true)

  for (let second = 0; second < 5; second += 1) {
    h.advance(1_000)
    h.tick()
    assert.equal(h.attention.snapshot().flashing, true, `still flashing after ${String(second + 1)}s`)
  }
})

test('moving the pointer ends it', () => {
  const h = harness()
  finishCurrentSession(h)
  h.advance(1_000)
  h.tick()

  h.state.cursor = { x: 101, y: 100 }
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.mouseMoved)
})

test('a one pixel move counts', () => {
  // A deliberate small nudge must register; requiring a threshold would make the
  // gesture unreliable.
  const h = harness()
  finishCurrentSession(h)

  h.state.cursor = { x: 100, y: 99 }
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().lastStop, STOP.mouseMoved)
})

test('switching session ends it without any pointer movement', () => {
  // The pointer cannot be the only exit: a keyboard-driven session switch has to
  // work too, or the flash would keep going after the person moved on.
  const h = harness()
  finishCurrentSession(h)
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true)

  h.state.session = 'other-session'
  h.dots.update({ counts: {}, mainSessionId: 'other-session' })
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.sessionSwitched)
})

test('leaving the window ends it', () => {
  const h = harness()
  finishCurrentSession(h)

  h.state.foreground = false
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.blurred)
})

test('a flash started in the background still ends on focus, not on the pointer', () => {
  // The existing contract: coming back to the window is itself the action, so the
  // pointer rule would only make that case nag.
  const h = harness()
  h.state.foreground = false
  h.dots.update({ counts: {}, mainSessionId: h.state.session })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: h.state.session }, { isMain: true })

  h.state.foreground = true
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.notEqual(h.attention.snapshot().lastStop, STOP.mouseMoved)
})

test('turning the option off restores the old behaviour', () => {
  const h = harness({ flashUntilMouseMoves: false })
  finishCurrentSession(h)

  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('an unreadable pointer falls back to the dot rule instead of flashing forever', () => {
  // A port without cursor support must not arm a wait that can never complete.
  const h = harness({}, { cursorReadable: false })
  finishCurrentSession(h)

  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('the pointer is sampled when the flash starts, not when it ends', () => {
  // A move that happens before the flash starts must not count as acknowledgement.
  const h = harness()
  h.state.cursor = { x: 500, y: 500 }
  finishCurrentSession(h)

  h.state.cursor = { x: 900, y: 900 }
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().lastStop, STOP.mouseMoved, 'that later move does count')
})

test('a self-test flash is not armed on the pointer', () => {
  // The self-test route exists to be driven by an external probe; making it wait
  // for a cursor move would make the probe hang.
  const h = harness()
  h.dots.update({ counts: { unread: 1 } })

  h.attention.notify({ kind: 'self-test' })

  h.advance(1_000)
  h.tick()

  assert.notEqual(h.attention.snapshot().lastStop, STOP.mouseMoved)
})

test('the armed state is cleared when the flash stops', () => {
  const h = harness()
  finishCurrentSession(h)
  h.state.cursor = { x: 0, y: 0 }
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.mouseMoved)

  // A later flash takes a fresh pointer baseline. Without that reset the stored
  // start position would be the previous flash's, so a move made long ago would
  // still read as an acknowledgement. The cursor stays where it was moved to.
  //
  // Restarted through the virtual main-session dot on purpose: this test is about
  // the pointer wait, which only exists when no real yellow/green dot is showing.
  h.advance(1_000)
  finishCurrentSession(h)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true)

  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'still flashing: the pointer has not moved since')

  h.state.cursor = { x: 5, y: 5 }
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().lastStop, STOP.mouseMoved)
})
