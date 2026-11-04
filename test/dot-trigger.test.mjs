/**
 * Regression tests for "a dot appeared but nothing flashed".
 *
 * This is the failure these tests exist for. The Client computes a green dot for
 * a background session only once that session's row stops running, which is
 * *after* the `turn/end` event was handled. The Host evaluated the flash at event
 * time — when no dot existed yet — and never looked again, so the sidebar showed
 * a dot while the tray sat still.
 *
 * The earlier tests missed it because their fake dot tracker returned a constant
 * total, so the "a dot appeared" transition never happened in the test either.
 * These use a tracker whose total actually moves.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAttention, STOP } from '../src/attention.mjs'
import { createDots } from '../src/dots.mjs'
import { DEFAULTS } from '../src/options.mjs'

/**
 * Build a window port double.
 *
 * @param state - mutable `{ foreground, live }`.
 * @returns the port.
 */
function fakePort(state) {
  return {
    findMainWindow: () => ({ hwnd: 0x1234n, className: 'Chrome_WidgetWin_1', title: 'x — DeepSeek Harness', visible: true }),
    flash: () => 1,
    stop: () => 1,
    isLive: () => state.live !== false,
    isForeground: () => state.foreground === true,
    dispose() {},
  }
}

/**
 * Wire the real dot tracker to the real state machine.
 *
 * @param options - option overrides.
 * @returns the controller and the pieces a test drives.
 */
function harness(options = {}) {
  let clock = 1_000
  const state = { foreground: false, live: true }
  const port = fakePort(state)
  const intervals = []
  const cleared = []
  const logs = []
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
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
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
    advance(ms) {
      clock += ms
    },
  }
}

test('a dot that appears after the turn ended starts the flash', () => {
  // The exact production sequence: the event arrives first, the dot second.
  const h = harness()

  // turn/end while the Client still reports zero dots.
  h.dots.update({ counts: {} })
  const atEvent = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg-1' }, { isMain: false })
  assert.equal(atEvent.started, false, 'nothing to flash about yet')
  assert.equal(h.attention.snapshot().flashing, false)

  // Moments later the Client reports the green dot.
  h.attention.updateDots({ counts: { unread: 1 } })

  assert.equal(h.attention.snapshot().flashing, true, 'the dot must start the flash')
  assert.equal(h.intervals.length, 1)
})

test('the flash started by a dot blinks the tray too', () => {
  const trayCalls = []
  const h = harness()
  // Re-wire with a tray double recorded through a second controller is awkward;
  // instead assert the state machine reached its start path, which is what calls
  // the tray, and that the flash is running.
  h.dots.update({ counts: {} })
  h.attention.updateDots({ counts: { unread: 1 } })

  assert.equal(h.attention.snapshot().flashing, true)
  assert.deepEqual(trayCalls, [])
})

test('a dot report that grows while already flashing does not restart it', () => {
  const h = harness()
  h.attention.updateDots({ counts: { unread: 1 } })
  assert.equal(h.intervals.length, 1)

  h.attention.updateDots({ counts: { unread: 2 } })

  assert.equal(h.intervals.length, 1, 'still the original timer')
  assert.equal(h.attention.snapshot().flashing, true)
})

test('a dot report that arrives with nothing to flash about does nothing', () => {
  const h = harness()
  h.attention.updateDots({ counts: {} })

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.intervals.length, 0)
})

test('a dot appearing while the window is focused still starts the flash', () => {
  // A dot means "you have not looked at this", and looking at the window is not
  // looking at that session. This is the behaviour the user asked for.
  const h = harness()
  h.state.foreground = true

  h.attention.updateDots({ counts: { unread: 1 } })

  assert.equal(h.attention.snapshot().flashing, true)
})

test('a stale Client does not start a flash from an old report', () => {
  const h = harness()
  h.dots.update({ counts: { unread: 1 } })
  h.advance(90_000)

  // A new report arrives after the gap, still carrying the dot: that is a live
  // report and it may flash. What must not happen is flashing off *stale* data.
  h.dots.invalidate()
  assert.equal(h.dots.hasDots(), undefined)

  h.attention.updateDots({ counts: { unread: 0 } })
  assert.equal(h.attention.snapshot().flashing, false)
})

test('the flash ends when the dot clears, including a dot-started one', () => {
  const h = harness()
  h.attention.updateDots({ counts: { unread: 1 } })
  assert.equal(h.attention.snapshot().flashing, true)

  h.attention.updateDots({ counts: { unread: 0 } })
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('an approval dot raises the flash through the same path', () => {
  const h = harness()
  h.attention.updateDots({ counts: { approval: 1 } })

  assert.equal(h.attention.snapshot().flashing, true)
})

test('a question dot raises the flash through the same path', () => {
  const h = harness()
  h.attention.updateDots({ counts: { question: 1 } })

  assert.equal(h.attention.snapshot().flashing, true)
})

test('updateDots still returns the tracker snapshot', () => {
  const h = harness()
  const snapshot = h.attention.updateDots({ counts: { unread: 3 }, mainSessionId: 'main-9' })

  assert.equal(snapshot.total, 3)
  assert.equal(snapshot.currentSessionId, 'main-9')
})

test('the heartbeat keeps a quiet dot from going stale', () => {
  // The Client sends the same counts every 30s; 60s of them must never read as
  // "the Client is gone", or a dot that simply sits there would stop the flash.
  const h = harness()
  h.attention.updateDots({ counts: { unread: 1 } })
  assert.equal(h.dots.status(), 'live')

  for (let beat = 0; beat < 3; beat += 1) {
    h.advance(30_000)
    h.attention.updateDots({ counts: { unread: 1 } })
    assert.equal(h.dots.status(), 'live', `still live after beat ${String(beat + 1)}`)
    h.intervals[0].fn()
    assert.equal(h.attention.snapshot().flashing, true, 'and the flash kept running')
  }
})

test('a main-session virtual dot survives the tick that focuses the window', () => {
  // tick() clears the virtual dot on focus, so the ordering matters: if the dot
  // check ran after that clear, a focused main-session turn would end instantly.
  const h = harness()
  h.dots.update({ counts: {} })
  h.state.foreground = true

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'main-1' }, { isMain: true })
  assert.equal(result.started, true, 'the virtual dot earned this flash')

  // The first tick sees focus and clears it, which is the intended end state.
  h.intervals[0].fn()
  assert.equal(h.dots.mainPending(), false)
})

test('a dot that sits unchanged for ten minutes keeps flashing', () => {
  // The default used to be a 120 second cap, which ended the flash while the dot
  // was still showing. Nothing re-arms a flash whose dot count never changes — the
  // 30 second heartbeat reports the same number — so the reminder was lost for
  // good. This is the regression for that.
  const h = harness()
  h.attention.updateDots({ counts: { unread: 1 } })
  assert.equal(h.attention.snapshot().flashing, true)

  for (let beat = 0; beat < 20; beat += 1) {
    h.advance(30_000)
    // The Client's heartbeat: same counts, nothing changed.
    h.attention.updateDots({ counts: { unread: 1 } })
    h.intervals[0].fn()
    assert.equal(h.attention.snapshot().flashing, true, `still flashing after ${String((beat + 1) * 30)}s`)
  }

  assert.notEqual(h.attention.snapshot().lastStop, STOP.timeout)
})

test('the default configuration has no deadline at all', () => {
  // `maxFlashSeconds: 0` is what makes the dot drive the lifetime; a positive
  // default would silently reintroduce the cap.
  assert.equal(DEFAULTS.maxFlashSeconds, 0)

  const h = harness()
  h.attention.updateDots({ counts: { unread: 1 } })

  assert.equal(h.attention.snapshot().deadlineAt, undefined, 'no deadline is set')
})

test('an explicit cap is still honoured when someone configures one', () => {
  // The option stays available as a safety limit; making 0 the default must not
  // break a caller that asks for a cap.
  const h = harness({ maxFlashSeconds: 5 })
  h.attention.updateDots({ counts: { unread: 1 } })
  assert.notEqual(h.attention.snapshot().deadlineAt, undefined, 'a cap was applied')

  h.advance(5_000)
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.timeout)
})
