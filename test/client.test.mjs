/**
 * Tests for the Client half.
 *
 * The bundle runs in the page, so these tests stand in for `window`, for
 * `fetch`, for timers and for the `uiSession` service. What matters is the
 * contract the Host depends on: the counts are right, a burst of changes is
 * coalesced, an unchanged total is not re-sent, and every failure path stays
 * silent instead of throwing into the page.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Load the bundle with a stub module loader.
 *
 * @returns the exported `{ apply, inject }` plus the registered id.
 */
async function loadBundle() {
  let registered
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        registered = { id, exports: factory(() => { throw new Error('unexpected require') }) }
      },
    },
  }
  await import(`../lib/client.js?cache=${String(Math.random())}`)
  return { id: registered.id, ...registered.exports }
}

/**
 * Build a fake `uiSession` service.
 *
 * @param initial - initial status rows, as `[id, status]` pairs.
 * @returns the service plus helpers to drive it.
 */
function fakeUiSession(initial = []) {
  const rows = new Map(initial)
  const listeners = new Set()
  const currentListeners = new Set()
  let currentKey
  return {
    rows,
    setCurrent(key) {
      currentKey = key
      for (const listener of currentListeners) listener()
    },
    publish(next) {
      rows.clear()
      for (const [id, status] of next) rows.set(id, status)
      for (const listener of listeners) listener()
    },
    service: {
      sessionStatus: {
        getSnapshot: () => new Map(rows),
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      current: {
        getSnapshot: () => ({ key: currentKey }),
        subscribe(listener) {
          currentListeners.add(listener)
          return () => currentListeners.delete(listener)
        },
      },
    },
  }
}

/**
 * Run `apply` with fake timers and a recording fetch.
 *
 * The bundle posts reports without awaiting them, so every test has to let the
 * microtask queue drain before the stub `fetch` is taken away — otherwise a
 * trailing call lands on Node's real `fetch`, which cannot parse a relative URL.
 *
 * @param uiSession - the fake service.
 * @returns the harness.
 */
function mount(uiSession) {
  const sent = []
  const timers = []
  const inflight = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (path, options) => {
    sent.push({ path, method: options?.method ?? 'GET', body: options?.body === undefined ? undefined : JSON.parse(options.body) })
    const settled = Promise.resolve({ ok: true })
    inflight.push(settled)
    return settled
  }
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (fn) => {
    const handle = { fn, cleared: false }
    timers.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (handle !== undefined) handle.cleared = true
  }
  // The heartbeat uses setInterval; stubbing it keeps a real 30s timer out of the
  // test process and lets a test fire the beat deliberately.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const beats = []
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false }
    beats.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    if (handle !== undefined) handle.cleared = true
  }

  const effects = []
  const ctx = {
    uiSession: uiSession.service,
    effect(factory) {
      effects.push(factory())
    },
  }

  return {
    ctx,
    effects,
    sent,
    timers,
    beats,
    /** Run every pending throttled timer. */
    flushTimers() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn()
    },
    /** Fire the keep-alive beat once. */
    fireHeartbeat() {
      for (const beat of beats) if (!beat.cleared) beat.fn()
    },
    /** Wait for every report this harness started. */
    async settled() {
      await Promise.allSettled(inflight)
      await new Promise((resolve) => setImmediate(resolve))
    },
    /** Run the registered disposers, as a page unload would. */
    teardown() {
      for (const dispose of effects) if (typeof dispose === 'function') dispose()
    },
    /** Undo the globals this harness replaced. */
    restore() {
      globalThis.fetch = realFetch
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

const bundle = await loadBundle()

test('the bundle registers itself under the package name', () => {
  assert.equal(bundle.id, 'dsh-tray-flash')
  assert.equal(typeof bundle.apply, 'function')
  assert.deepEqual(bundle.inject, ['uiSession'])
})

test('mounting reports the current dots immediately', async () => {
  const ui = fakeUiSession([
    ['a', { completionUnread: true }],
    ['b', { pendingInteraction: { kind: 'approval' } }],
  ])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)

    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].path, '/__tray-flash/dots')
    assert.equal(h.sent[0].method, 'POST')
    assert.deepEqual(h.sent[0].body.counts, { approval: 1, question: 0, unread: 1 })
  } finally {
    await h.settled()
    h.restore()
  }
})

test('a plan review counts as a question dot', async () => {
  const ui = fakeUiSession([['a', { pendingInteraction: { kind: 'plan-review' } }]])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    assert.deepEqual(h.sent[0].body.counts, { approval: 0, question: 1, unread: 0 })
  } finally {
    await h.settled()
    h.restore()
  }
})

test('a change is coalesced into one throttled report', async () => {
  const ui = fakeUiSession([])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    h.sent.length = 0

    // Three changes inside one throttle window.
    ui.publish([['a', { completionUnread: true }]])
    ui.publish([['a', { completionUnread: true }], ['b', { completionUnread: true }]])
    ui.publish([['a', { completionUnread: true }]])

    assert.equal(h.sent.length, 0, 'nothing sent synchronously')
    h.flushTimers()
    assert.equal(h.sent.length, 1, 'one report for the burst')
    assert.deepEqual(h.sent[0].body.counts, { approval: 0, question: 0, unread: 1 })
  } finally {
    await h.settled()
    h.restore()
  }
})

test('an unchanged total is not re-sent', async () => {
  const ui = fakeUiSession([['a', { completionUnread: true }]])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    h.sent.length = 0

    // Same count, different session ids: the Host only needs the total.
    ui.publish([['b', { completionUnread: true }]])
    h.flushTimers()

    assert.equal(h.sent.length, 0)
  } finally {
    await h.settled()
    h.restore()
  }
})

test('the main session id travels with every report', async () => {
  const ui = fakeUiSession([['s1', { completionUnread: true }]])
  ui.setCurrent('s1')
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    assert.equal(h.sent[0].body.mainSessionId, 's1')
  } finally {
    await h.settled()
    h.restore()
  }
})

test('switching the main session produces a report even at the same counts', async () => {
  const ui = fakeUiSession([['s1', { completionUnread: true }]])
  ui.setCurrent('s1')
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    h.sent.length = 0

    ui.setCurrent('s2')
    h.flushTimers()

    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].body.mainSessionId, 's2')
  } finally {
    await h.settled()
    h.restore()
  }
})

test('no main session is reported as null', async () => {
  const ui = fakeUiSession([])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    assert.equal(h.sent[0].body.mainSessionId, null)
  } finally {
    await h.settled()
    h.restore()
  }
})

test('unloading clears the dots with a keepalive DELETE', async () => {
  const ui = fakeUiSession([])
  const h = mount(ui)
  let removed
  try {
    bundle.apply(h.ctx)
    h.sent.length = 0
    // Run the disposer the bundle registered, which is what a page unload does.
    for (const dispose of h.effects) if (typeof dispose === 'function') dispose()
  } finally {
    await h.settled()
    removed = h.sent.find((entry) => entry.method === 'DELETE')
    h.restore()
  }

  assert.notEqual(removed, undefined)
  assert.equal(removed.path, '/__tray-flash/dots')
})

test('a missing sessionStatus warns and disposes cleanly', () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (line) => warnings.push(line)
  const effects = []
  try {
    bundle.apply({
      uiSession: {},
      effect(factory) {
        effects.push(factory())
      },
    })
  } finally {
    console.warn = realWarn
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sessionStatus is unavailable/)
  assert.equal(typeof effects[0], 'function', 'and still returns a disposer')
})

test('a failing fetch does not throw into the page', async () => {
  const ui = fakeUiSession([['a', { completionUnread: true }]])
  const h = mount(ui)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('host is restarting')
  }
  try {
    assert.doesNotThrow(() => bundle.apply(h.ctx))
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    globalThis.fetch = realFetch
    h.restore()
  }
})

test('a malformed status snapshot is counted as no dots', async () => {
  const h = mount({ service: { sessionStatus: { getSnapshot: () => undefined, subscribe: () => () => {} } } })
  try {
    bundle.apply(h.ctx)
    assert.deepEqual(h.sent[0].body.counts, { approval: 0, question: 0, unread: 0 })
  } finally {
    await h.settled()
    h.restore()
  }
})

test('the heartbeat reports the same counts even when nothing changed', async () => {
  // Silence reads as "the Client is gone" on the Host after dotsStaleSeconds, and
  // that would stop the flash on a dot that simply sits there. The beat is what
  // keeps "no change" from becoming "no Client".
  const ui = fakeUiSession([['a', { completionUnread: true }]])
  const h = mount(ui)
  try {
    bundle.apply(h.ctx)
    assert.equal(h.sent.length, 1, 'the mount report')
    h.sent.length = 0

    // No status change at all; only the beat fires.
    h.fireHeartbeat()

    assert.equal(h.sent.length, 1, 'the heartbeat still sent a report')
    assert.deepEqual(h.sent[0].body.counts, { approval: 0, question: 0, unread: 1 })
  } finally {
    await h.settled()
    h.restore()
  }
})

test('the heartbeat is one 30 second interval, cleared on unload', async () => {
  const ui = fakeUiSession([])
  const h = mount(ui)
  let beat
  try {
    bundle.apply(h.ctx)
    assert.equal(h.beats.length, 1, 'exactly one interval')
    beat = h.beats[0]
    // 30s is half the Host's 60s default staleness window.
    assert.equal(beat.ms, 30_000)

    h.teardown()
    assert.equal(beat.cleared, true, 'unloading stops the beat')
  } finally {
    await h.settled()
    h.restore()
  }
})
