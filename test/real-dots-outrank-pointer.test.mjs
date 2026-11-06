/**
 * The dot rule outranks the pointer rule.
 *
 * `flashUntilMouseMoves` exists for one case the dots cannot cover: a turn that
 * finished in the session already on screen, where the main session never earns a
 * real yellow/green dot. Arming that pointer wait for a *dot-triggered* flash was
 * the regression: the sidebar still showed a green or yellow dot, yet the first
 * mouse move (which is what focusing the window is) stopped the blink.
 *
 * These tests pin the contract from the README: as long as a real yellow/green
 * dot is showing, neither focus, blur, a session switch nor the pointer can end
 * the flash; only the dots reaching zero can.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAttention, STOP } from '../src/attention.mjs'
import { createDots } from '../src/dots.mjs'
import { DEFAULTS } from '../src/options.mjs'

/**
 * Build a controller whose window focus and cursor are drivable.
 *
 * @returns the controller, its dot tracker and the knobs the tests turn.
 */
function harness() {
  let clock = 1_000
  const state = {
    foreground: true,
    cursor: { x: 100, y: 100 },
  }
  const intervals = []

  const port = {
    findMainWindow: () => ({ hwnd: 0x1234n, className: 'Chrome_WidgetWin_1', title: 'x — DeepSeekRuntime', visible: true }),
    flash: () => 1,
    stop: () => 1,
    isLive: () => true,
    isForeground: () => state.foreground,
    cursorPosition: () => state.cursor,
    cursorMoved: (previous, current) => previous !== undefined
      && current !== undefined
      && (previous.x !== current.x || previous.y !== current.y),
  }

  const dots = createDots({
    staleSeconds: 60,
    virtualMain: true,
    now: () => clock,
    logger: { debug: () => {}, warn: () => {} },
  })

  const attention = createAttention({
    port,
    options: { ...DEFAULTS },
    pids: [4242],
    logger: { info: () => {}, warn: () => {} },
    dots,
    now: () => clock,
    setIntervalFn: (fn) => {
      const handle = { fn, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearIntervalFn: () => {},
  })

  return {
    attention,
    dots,
    state,
    tick: () => intervals.at(-1)?.fn(),
    advance(ms) {
      clock += ms
    },
  }
}

/**
 * Deliver one Client dot report exactly the way the route does.
 *
 * @param h - harness.
 * @param counts - `{ approval, question, unread }`.
 * @param mainSessionId - the session the main pane is showing.
 */
function report(h, counts, mainSessionId = 'main-1') {
  const payload = { counts, mainSessionId }
  h.dots.update(payload)
  h.attention.updateDots(payload)
}

test('a green dot keeps flashing when the pointer moves', () => {
  const h = harness()
  report(h, { unread: 1 })
  assert.equal(h.attention.snapshot().flashing, true, 'the dot starts the flash')

  h.advance(1_000)
  h.tick()
  h.state.cursor = { x: 101, y: 100 }
  h.advance(1_000)
  h.tick()

  assert.equal(h.attention.snapshot().flashing, true, 'the dot, not the pointer, governs')
  assert.notEqual(h.attention.snapshot().lastStop, STOP.mouseMoved)

  report(h, {})
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('a yellow approval dot survives focus, blur, a session switch and the pointer', () => {
  const h = harness()
  report(h, { approval: 1 })

  h.state.cursor = { x: 300, y: 300 }
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'pointer movement does not end it')

  h.state.foreground = false
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'leaving the window does not end it')

  h.state.foreground = true
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'coming back does not end it')

  report(h, { approval: 1 }, 'another-session')
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'switching session does not end it')

  report(h, {})
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('a dot that appears after the pointer wait was armed takes over', () => {
  const h = harness()

  // A focused main-session turn: no real dot, so the pointer is the signal.
  h.dots.update({ counts: {}, mainSessionId: 'main-1' })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'main-1' }, { isMain: true })
  assert.equal(h.attention.snapshot().flashing, true)

  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'the pointer has not moved yet')

  // A waiting question arrives while the flash is still running.
  report(h, { question: 1 })

  h.state.cursor = { x: 150, y: 150 }
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'the new dot outranks the pointer wait')
  assert.notEqual(h.attention.snapshot().lastStop, STOP.mouseMoved)

  report(h, {})
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('a background-started dot flash keeps flashing after returning to the window', () => {
  const h = harness()
  h.state.foreground = false
  report(h, { unread: 2 })
  assert.equal(h.attention.snapshot().flashing, true)

  h.state.foreground = true
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true, 'the green dots are still there')

  h.state.cursor = { x: 50, y: 50 }
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().flashing, true)

  report(h, {})
  h.advance(1_000)
  h.tick()
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})
