/**
 * Tests for the attention state machine.
 *
 * Everything here runs against a fake window port and a hand-cranked clock, so
 * the policy — deduplication, the focus stop, the deadline, the interrupt and
 * sub-agent filters — is asserted without a screen, a Host, or Windows.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAttention, SOURCE, STOP, clampInterval, handleText } from '../src/attention.mjs'
import { DEFAULTS } from '../src/options.mjs'

/**
 * Build a fake window port that records every call.
 *
 * @param overrides - per-method replacements.
 * @returns the port plus its call log and mutable flags.
 */
function fakePort(overrides = {}) {
  const calls = []
  const state = { live: true, foreground: false, hwnd: 0x1a2bn }
  const port = {
    calls,
    state,
    findMainWindow() {
      calls.push(['findMainWindow'])
      return { hwnd: state.hwnd, className: 'Chrome_WidgetWin_1', title: 'x — DeepSeek Harness', visible: true }
    },
    flash(hwnd, options) {
      calls.push(['flash', hwnd, options])
      return 1
    },
    stop(hwnd) {
      calls.push(['stop', hwnd])
      return 1
    },
    isLive() {
      calls.push(['isLive'])
      return state.live
    },
    isForeground() {
      calls.push(['isForeground'])
      return state.foreground
    },
    dispose() {},
    ...overrides,
  }
  return port
}

/**
 * Build a controller wired to a fake port and a controllable clock.
 *
 * @param overrides - option overrides.
 * @returns the controller and its harness.
 */
function harness(overrides = {}) {
  const port = overrides.port ?? fakePort()
  const options = { ...DEFAULTS, ...(overrides.options ?? {}) }
  const tray = overrides.tray
  const dots = overrides.dots
  let clock = 1_000
  const intervals = []
  const cleared = []
  const logs = []

  const attention = createAttention({
    port,
    options,
    pids: [4242],
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
    tray,
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
    port,
    options,
    logs,
    intervals,
    cleared,
    advance(ms) {
      clock += ms
    },
    get clock() {
      return clock
    },
  }
}

test('a finished turn starts exactly one flash', () => {
  const h = harness()
  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, true)
  assert.equal(h.port.calls.filter(([name]) => name === 'flash').length, 1)
  assert.deepEqual(h.attention.snapshot().pending, ['s1'])
  assert.equal(h.intervals.length, 1, 'one poll interval is running')
})

test('already being in the window suppresses the flash', () => {
  const h = harness()
  h.port.state.foreground = true

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'focused')
  assert.equal(h.port.calls.filter(([name]) => name === 'flash').length, 0)
  assert.equal(h.intervals.length, 0)
})

test('further events join the running flash instead of restarting it', () => {
  const h = harness()
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.advance(5_000)
  const before = h.attention.snapshot()

  const result = h.attention.notifyApproval({ id: 's2' })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'already-flashing')
  assert.equal(h.port.calls.filter(([name]) => name === 'flash').length, 1, 'no second flash call')
  assert.equal(h.attention.snapshot().startedAt, before.startedAt, 'deadline was not pushed back')
  assert.deepEqual(h.attention.snapshot().pending, ['s1', 's2'])
})

test('the first focus poll stops the flash and clears pending work', () => {
  const h = harness()
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.port.state.foreground = true

  h.intervals[0].fn()

  const snapshot = h.attention.snapshot()
  assert.equal(snapshot.flashing, false)
  assert.deepEqual(snapshot.pending, [])
  assert.equal(snapshot.lastStop, STOP.focused)
  assert.equal(h.cleared.length, 1, 'the interval was cleared')
  assert.equal(h.port.calls.filter(([name]) => name === 'stop').length, 1, 'and the flash was cancelled')
})

test('a destroyed window stops the flash instead of polling forever', () => {
  const h = harness()
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.port.state.live = false

  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.windowGone)
})

test('the deadline stops a flash nobody answered', () => {
  const h = harness({ options: { maxFlashSeconds: 10 } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  h.advance(9_000)
  h.intervals[0].fn()
  assert.equal(h.attention.snapshot().flashing, true, 'still flashing before the deadline')

  h.advance(1_000)
  h.intervals[0].fn()
  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.timeout)
})

test('maxFlashSeconds 0 means no deadline at all', () => {
  const h = harness({ options: { maxFlashSeconds: 0 } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.advance(86_400_000)
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, true)
  assert.equal(h.attention.snapshot().deadlineAt, undefined)
})

test('sub-agent sessions never raise attention', () => {
  const h = harness()

  for (const header of [{ origin: 'subagent' }, { parentSession: 'parent-1' }]) {
    const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'child', header })
    assert.equal(result.started, false)
    assert.equal(result.reason, 'ignored-session')
  }
  assert.equal(h.port.calls.filter(([name]) => name === 'flash').length, 0)
})

test('ignoreSubagent false lets sub-agent sessions through', () => {
  const h = harness({ options: { ignoreSubagent: false } })
  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'child', header: { origin: 'subagent' } })
  assert.equal(result.started, true)
})

test('interrupted turns are skipped only when asked', () => {
  const strict = harness()
  const skipped = strict.attention.notifyTurnEnd({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }, { id: 's1' })
  assert.equal(skipped.started, false)
  assert.equal(skipped.reason, 'ignored-interrupted')

  const lenient = harness({ options: { ignoreInterrupted: false } })
  const started = lenient.attention.notifyTurnEnd({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }, { id: 's1' })
  assert.equal(started.started, true)
})

test('a normal completion reason always counts', () => {
  const h = harness()
  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, { id: 's1' })
  assert.equal(result.started, true)
})

test('a Host without FFI is inert, not broken', () => {
  const attention = createAttention({
    port: undefined,
    options: { ...DEFAULTS },
    pids: [1],
    logger: {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  })

  const result = attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  assert.equal(result.started, false)
  assert.equal(result.reason, 'no-ffi')
})

test('a missing window defers the flash without throwing', () => {
  const port = fakePort({ findMainWindow: () => undefined })
  const h = harness({ port })

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'no-window')
  assert.equal(result.pending, 1, 'the reason is remembered for a later retry')
  assert.equal(h.intervals.length, 0)
})

test('a throwing flash call is reported and leaves no timer behind', () => {
  const port = fakePort({ flash: () => { throw new Error('access denied') } })
  const h = harness({ port })

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'flash-failed')
  assert.match(result.error, /access denied/)
  assert.equal(h.intervals.length, 0, 'no poll interval was left running')
})

test('disabled config short-circuits before touching Win32', () => {
  const h = harness({ options: { enabled: false } })
  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.reason, 'disabled')
  assert.deepEqual(h.port.calls, [])
})

test('dispose cancels the running flash exactly once', () => {
  const h = harness()
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  h.attention.dispose()
  h.attention.dispose()

  assert.equal(h.port.calls.filter(([name]) => name === 'stop').length, 1)
  assert.equal(h.cleared.length, 1)
  assert.equal(h.attention.snapshot().disposed, true)
})

test('flash options reach the port in the documented shape', () => {
  const h = harness({ options: { flashCaption: false, flashCount: 7, flashTimeout: 250 } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  const [, , options] = h.port.calls.find(([name]) => name === 'flash')
  assert.deepEqual(options, { caption: false, count: 7, timeout: 250 })
})

test('the poll interval is clamped to a safe range', () => {
  assert.equal(clampInterval(1), 200)
  assert.equal(clampInterval(99_999), 5_000)
  assert.equal(clampInterval('750'), 750)
  assert.equal(clampInterval(undefined), 1_000)
  assert.equal(clampInterval(Number.NaN), 1_000)
})

test('window handles render as hexadecimal text', () => {
  assert.equal(handleText(0x1a2bn), '0x1a2b')
  assert.equal(handleText(6699), '0x1a2b')
  assert.equal(handleText('not-a-handle'), 'not-a-handle')
})

test('every documented source has a distinct name', () => {
  assert.deepEqual(Object.values(SOURCE).sort(), ['approval', 'question', 'turn-end'])
})

/**
 * Build a fake tray controller that records start/stop/dispose.
 *
 * @param startResult - what `start()` should report.
 * @returns the controller double.
 */
function fakeTray(startResult = true) {
  const calls = []
  return {
    calls,
    start() {
      calls.push('start')
      return startResult
    },
    stop() {
      calls.push('stop')
      return true
    },
    dispose() {
      calls.push('dispose')
    },
    snapshot() {
      return { available: true, blinking: calls.includes('start') && !calls.includes('stop') }
    },
  }
}

test('the tray blink starts and stops with the taskbar flash', () => {
  const tray = fakeTray()
  const h = harness({ tray })

  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  assert.deepEqual(tray.calls, ['start'], 'one start, driven by the same decision')

  h.port.state.foreground = true
  h.intervals[0].fn()
  assert.deepEqual(tray.calls, ['start', 'stop'], 'the focus stop restores the icon')
})

test('a tray that cannot blink still leaves the taskbar flash running', () => {
  const tray = fakeTray(false)
  const h = harness({ tray })

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, true)
  assert.equal(result.tray, false)
  assert.equal(h.port.calls.filter(([name]) => name === 'flash').length, 1)
})

test('a throwing tray never breaks the flash', () => {
  const tray = {
    start() { throw new Error('shell exploded') },
    stop() { throw new Error('shell exploded') },
    dispose() {},
    snapshot: () => ({}),
  }
  const h = harness({ tray })

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.equal(result.started, true)
  assert.equal(result.tray, false)
  assert.match(h.logs.map(([, line]) => line).join('\n'), /tray blink failed/)
})

test('trayBlink false never touches the tray', () => {
  const tray = fakeTray()
  const h = harness({ tray, options: { trayBlink: false } })

  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.deepEqual(tray.calls, [])
})

test('dispose releases the tray handles after restoring the image', () => {
  const tray = fakeTray()
  const h = harness({ tray })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  h.attention.dispose()

  assert.deepEqual(tray.calls, ['start', 'stop', 'dispose'])
})

test('the snapshot carries the tray state for the diagnostic route', () => {
  const tray = fakeTray()
  const h = harness({ tray })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })

  assert.deepEqual(h.attention.snapshot().tray, { available: true, blinking: true })
})

test('onlyWhenUnfocused false is not cancelled by the focus poll', () => {
  // A deliberate always-flash configuration (or the self-test route) must not be
  // undone by the very condition it was told to ignore.
  const h = harness({ options: { onlyWhenUnfocused: false } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.port.state.foreground = true

  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, true, 'the flash keeps running')
  assert.notEqual(h.attention.snapshot().lastStop, STOP.focused)
})

test('the deadline still ends an always-flash run', () => {
  const h = harness({ options: { onlyWhenUnfocused: false, maxFlashSeconds: 5 } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 's1' })
  h.port.state.foreground = true

  h.advance(5_000)
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.timeout)
})

/**
 * Build a fake dot tracker with a settable answer.
 *
 * The answer is read from an options object rather than taken as a default
 * parameter: `fakeDots({ answer: undefined })` would otherwise trigger the default and test
 * the "dots remain" case while claiming to test the "unknown" one.
 *
 * @param options - `answer` is true, false or undefined (unknown).
 * @returns the tracker double plus its call log.
 */
function fakeDots(options = {}) {
  const calls = []
  let answer = 'answer' in options ? options.answer : true
  let total = answer === true ? 1 : 0
  return {
    calls,
    set(next, nextTotal) {
      answer = next
      if (nextTotal !== undefined) total = nextTotal
    },
    update(report) {
      calls.push(['update', report])
      return { total }
    },
    noteTurnEnd(sessionId, isMain) {
      calls.push(['noteTurnEnd', sessionId, isMain])
      return isMain === true
    },
    noteFocused() {
      calls.push('noteFocused')
      return false
    },
    clear() {
      calls.push('clear')
    },
    warnIfStale() {},
    hasDots: () => answer,
    isLive: () => answer !== undefined,
    status: () => (answer === undefined ? 'absent' : 'live'),
    total: () => total,
    mainPending: () => false,
    currentSessionId: () => undefined,
    snapshot: () => ({ status: 'live', total }),
  }
}

test('a flash keeps running while dots remain, even with the window focused', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })
  h.port.state.foreground = true

  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, true, 'the dot outranks focus')
})

test('the flash stops once every dot clears', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })
  h.advance(2_000)

  dots.set(false)
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().flashing, false)
  assert.equal(h.attention.snapshot().lastStop, STOP.dotsCleared)
})

test('an unknown dot state falls back to focus instead of guessing', () => {
  // The Client never reported, so the tracker answers "unknown". Treating that as
  // "clear" would kill the flash instantly; treating it as "dots" would keep it
  // running forever. The rule is the old focus one.
  const dots = fakeDots({ answer: undefined })
  const h = harness({ dots })

  // Started while the window was in the background, so the flash begins.
  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })
  assert.equal(result.started, true)

  // Coming back to the window ends it, because nothing better is known.
  h.port.state.foreground = true
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.focused)
})

test('an unknown dot state does not start a flash in a focused window', () => {
  // Without a dot the event says nothing a person has not already seen.
  const dots = fakeDots({ answer: undefined })
  const h = harness({ dots })
  h.port.state.foreground = true

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'focused')
})

test('a virtual dot lets a focused main-session turn start a flash', () => {
  const dots = fakeDots({ answer: false })
  const h = harness({ dots })
  h.port.state.foreground = true

  const result = h.attention.notifyTurnEnd(
    { type: 'turn/end', data: {} },
    { id: 'main' },
    { isMain: true },
  )

  assert.equal(result.started, true, 'the virtual dot made this worth flashing')
  assert.deepEqual(dots.calls[0], ['noteTurnEnd', 'main', true])
})

test('a background session with no dots does not flash', () => {
  const dots = fakeDots({ answer: false })
  const h = harness({ dots })
  h.port.state.foreground = true

  const result = h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' }, { isMain: false })

  assert.equal(result.started, false)
  assert.equal(result.reason, 'no-dots')
})

test('stopWhenDotsClear false restores the plain focus rule', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots, options: { stopWhenDotsClear: false } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })
  h.port.state.foreground = true

  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.focused)
})

test('the deadline still ends a flash that never clears its dots', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots, options: { maxFlashSeconds: 5 } })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })

  h.advance(5_000)
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.timeout)
})

test('a closing window still stops before the dot rule runs', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })

  h.port.state.live = false
  h.intervals[0].fn()

  assert.equal(h.attention.snapshot().lastStop, STOP.windowGone)
})

test('the dots are consulted on every tick, not cached at start', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })

  h.intervals[0].fn()
  assert.equal(h.attention.snapshot().flashing, true)

  dots.set(false)
  h.intervals[0].fn()
  assert.equal(h.attention.snapshot().flashing, false)
})

test('the snapshot exposes dots for the diagnostic route', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })
  h.attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'bg' })

  assert.deepEqual(h.attention.snapshot().dots, { status: 'live', total: 1 })
})

test('dot reports and clears reach the tracker', () => {
  const dots = fakeDots({ answer: true })
  const h = harness({ dots })

  h.attention.updateDots({ counts: { unread: 2 } })
  h.attention.clearDots()

  assert.deepEqual(dots.calls[0], ['update', { counts: { unread: 2 } }])
  assert.equal(dots.calls[1], 'clear')
})
