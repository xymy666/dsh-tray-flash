/**
 * Tests for the tray blink controller.
 *
 * The real shell cannot be driven from a test, so a fake tray port stands in for
 * user32/shell32 and the assertions cover the parts that actually break in
 * practice: icon-id discovery, the load-once/destroy-once lifecycle, restoring
 * the application's own image on every stop path, and degrading quietly to
 * "taskbar only" when the tray is unreachable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTrayBlink, findTrayIcon } from '../src/tray.mjs'

/**
 * Build a fake tray port.
 *
 * @param overrides - per-method replacements.
 * @returns the port plus its call log.
 */
function fakePort(overrides = {}) {
  const calls = []
  const state = {
    hosts: [0x11n],
    /** uid -> rectangle, or absent when the id is unused. */
    icons: new Map([[3, { left: 1381, top: 1032, right: 1413, bottom: 1080 }]]),
    loaded: 0,
    released: 0,
    setIconOk: true,
    currently: undefined,
  }
  const port = {
    calls,
    state,
    trayHostWindows(pids) {
      calls.push(['trayHostWindows', pids])
      return state.hosts
    },
    rectOf(hwnd, uid) {
      calls.push(['rectOf', hwnd, uid])
      return state.icons.get(uid)
    },
    loadIcon(path) {
      calls.push(['loadIcon', path])
      state.loaded += 1
      if (path.includes('missing')) return undefined
      return { handle: state.loaded, path }
    },
    setIcon(hwnd, uid, icon) {
      calls.push(['setIcon', hwnd, uid, icon.path])
      if (!state.setIconOk) return false
      state.currently = icon.path
      return true
    },
    releaseIcon(icon) {
      calls.push(['releaseIcon', icon?.path])
      state.released += 1
    },
    ...overrides,
  }
  return port
}

/**
 * Build a controller with a controllable timer.
 *
 * @param overrides - port or option overrides.
 * @returns the controller plus its harness.
 */
function harness(overrides = {}) {
  const port = overrides.port ?? fakePort()
  const intervals = []
  const cleared = []
  const logs = []
  const tray = createTrayBlink({
    port,
    originalIconPath: 'D:\\DSH\\resources\\tray.ico',
    blankIconPath: 'E:\\plugin\\assets\\blank.ico',
    pids: [4242],
    intervalMs: 600,
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearIntervalFn: (handle) => cleared.push(handle),
    ...overrides.deps,
  })
  return { tray, port, intervals, cleared, logs }
}

test('the icon id is discovered by probing the shell for a rectangle', () => {
  const port = fakePort()

  const found = findTrayIcon(port)

  assert.deepEqual(found, { hwnd: 0x11n, uid: 3 })
  // Every id below the real one was probed and rejected.
  const probed = port.calls.filter(([name]) => name === 'rectOf').map(([, , uid]) => uid)
  assert.deepEqual(probed.slice(0, 4), [0, 1, 2, 3])
})

test('no tray host window means no icon, not a throw', () => {
  const port = fakePort()
  port.state.hosts = []
  assert.equal(findTrayIcon(port), undefined)
})

test('start loads both images once and shows the blank one first', () => {
  const h = harness()

  assert.equal(h.tray.start(), true)

  const loads = h.port.calls.filter(([name]) => name === 'loadIcon').map(([, path]) => path)
  assert.deepEqual(loads, ['D:\\DSH\\resources\\tray.ico', 'E:\\plugin\\assets\\blank.ico'])
  assert.equal(h.port.state.currently, 'E:\\plugin\\assets\\blank.ico')
  assert.equal(h.intervals.length, 1)
  assert.equal(h.intervals[0].ms, 600)
})

test('starting twice does not register a second timer', () => {
  const h = harness()
  h.tray.start()
  h.tray.start()

  assert.equal(h.intervals.length, 1)
  assert.equal(h.port.state.loaded, 2, 'icons were not reloaded')
})

test('each tick flips between the two images', () => {
  const h = harness()
  h.tray.start()

  h.intervals[0].fn()
  assert.equal(h.port.state.currently, 'D:\\DSH\\resources\\tray.ico')

  h.intervals[0].fn()
  assert.equal(h.port.state.currently, 'E:\\plugin\\assets\\blank.ico')
})

test('stop restores the application icon and clears the timer', () => {
  const h = harness()
  h.tray.start()

  assert.equal(h.tray.stop(), true)

  assert.equal(h.port.state.currently, 'D:\\DSH\\resources\\tray.ico')
  assert.equal(h.cleared.length, 1)
  assert.equal(h.tray.snapshot().blinking, false)
})

test('stop is harmless before start', () => {
  const h = harness()
  assert.equal(h.tray.stop(), false)
  assert.equal(h.port.calls.filter(([name]) => name === 'setIcon').length, 0)
})

test('a missing blank icon degrades to unavailable instead of blinking wrong', () => {
  const port = fakePort()
  const h = harness({ port })
  // The fake refuses any path containing "missing"; point the blank path at one.
  const tray = createTrayBlink({
    port,
    originalIconPath: 'D:\\DSH\\resources\\tray.ico',
    blankIconPath: 'E:\\missing\\blank.ico',
    pids: [4242],
    intervalMs: 600,
    logger: { info: () => {}, warn: () => {} },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  })

  assert.equal(tray.start(), false)
  assert.equal(tray.snapshot().blinking, false)
  // The one icon that did load is not leaked.
  assert.equal(port.state.released, 1)
  assert.equal(h.tray.start(), true, 'an independent controller still works')
})

test('a refused shell call disables blinking and says so once', () => {
  const port = fakePort()
  port.state.setIconOk = false
  const warnings = []
  const tray = createTrayBlink({
    port,
    originalIconPath: 'D:\\DSH\\resources\\tray.ico',
    blankIconPath: 'E:\\plugin\\assets\\blank.ico',
    pids: [4242],
    intervalMs: 600,
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  })

  assert.equal(tray.start(), false)
  assert.equal(tray.start(), false, 'a second attempt is a cheap no-op')
  assert.equal(warnings.length, 1, 'warned once, not per event')
})

test('dispose restores the image and releases both handles', () => {
  const h = harness()
  h.tray.start()

  h.tray.dispose()

  assert.equal(h.port.state.currently, 'D:\\DSH\\resources\\tray.ico')
  assert.equal(h.port.state.released, 2)
  assert.deepEqual(h.tray.snapshot().target, undefined)
})

test('the snapshot exposes what a diagnostic route wants to print', () => {
  const h = harness()
  h.tray.start()

  const snapshot = h.tray.snapshot()
  assert.equal(snapshot.blinking, true)
  assert.equal(snapshot.showingBlank, true)
  assert.equal(snapshot.target.hwnd, '0x11')
  assert.equal(snapshot.target.uid, 3)
})
