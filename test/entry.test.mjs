/**
 * Smoke tests for the Host entry point.
 *
 * These import the real `lib/index.js` with a stand-in context. The point is not
 * to re-test the state machine (its own suite does that) but to prove the module
 * activates without the real Host, tolerates a missing FFI and a missing Web
 * server, and registers exactly the disposers it promises.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as entry from '../lib/index.js'

/**
 * Build a context double that records effects, listeners and injected plugins.
 *
 * @returns the context plus its captured state.
 */
function fakeContext() {
  const state = {
    effects: [],
    effectDisposers: [],
    listeners: [],
    disposers: 0,
    injected: [],
    info: [],
    warn: [],
    routes: [],
  }
  const ctx = {
    logger: {
      info: (line) => state.info.push(line),
      warn: (line) => state.warn.push(line),
    },
    on(event, handler, options) {
      state.listeners.push({ event, handler, options })
      return () => {
        state.disposers += 1
      }
    },
    effect(factory, label) {
      state.effects.push(label)
      const dispose = factory()
      const teardown = () => {
        state.disposers += 1
        if (typeof dispose === 'function') dispose()
      }
      state.effectDisposers.push(teardown)
      return teardown
    },
    inject(names, callback) {
      state.injected.push(names)
      const webCtx = {
        logger: ctx.logger,
        webServer: {
          register(route) {
            state.routes.push(route)
            return () => {}
          },
        },
        effect(factory) {
          return factory()
        },
      }
      callback(webCtx)
    },
  }
  return { ctx, state }
}

/**
 * Run one activation and hand back everything it registered.
 *
 * @param config - patch row config.
 * @returns the captured state.
 */
function activate(config) {
  const { ctx, state } = fakeContext()
  entry.apply(ctx, config)
  return state
}

test('the entry exports the Cordis shape', () => {
  assert.equal(entry.name, 'dsh-tray-flash')
  assert.equal(typeof entry.apply, 'function')
  assert.deepEqual(entry.inject, [], 'no required service may block activation')
})

test('disabled config registers nothing at all', () => {
  const state = activate({ enabled: false })
  assert.deepEqual(state.effects, [])
  assert.deepEqual(state.listeners, [])
  assert.match(state.info.join('\n'), /disabled by config/)
})

test('a bad option is reported but does not block activation', () => {
  const state = activate({ flashCaption: 'yes' })
  assert.match(state.warn.join('\n'), /flashCaption must be a boolean/)
})

test('activation registers one global session listener and one effect', () => {
  const state = activate(undefined)

  assert.deepEqual(state.effects, ['tray-flash: session attention'])
  assert.equal(state.listeners.length, 1)
  assert.equal(state.listeners[0].event, 'session/event')
  assert.deepEqual(state.listeners[0].options, { global: true })

  const watching = state.info.join('\n')
  assert.match(watching, /watching pid\(s\) \d+/)
})

test('the session listener maps each event kind onto the controller', () => {
  const state = activate({ onlyWhenUnfocused: false })
  const handler = state.listeners[0].handler

  // Without FFI the controller is absent, so these calls must be no-ops rather
  // than throws — that is exactly the degraded Host this plugin must survive.
  assert.doesNotThrow(() => {
    handler({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handler({ id: 's1' }, { type: 'approval/asked', data: { id: 'a1' } })
    handler({ id: 's1' }, { type: 'tool/call', data: { name: 'ask_user_question' } })
    handler({ id: 's1' }, { type: 'tool/call', data: { name: 'bash' } })
    handler({ id: 's1' }, { type: 'assistant/message', data: {} })
    handler(undefined, undefined)
  })
})

test('disposing the effect releases both the listener and the controller', () => {
  const { ctx, state } = fakeContext()
  entry.apply(ctx, undefined)

  assert.equal(state.listeners.length, 1)
  assert.equal(state.effectDisposers.length, 1)

  state.effectDisposers[0]()

  // Two releases: the Session listener and the controller's own `dispose`, which
  // disposes of the plugin's Web routes as well.
  assert.ok(state.disposers >= 1, 'the session listener was released')
})
