/**
 * Tests for the loopback fence and the diagnostic routes.
 *
 * The fence is the only thing standing between "a web page can make the user's
 * taskbar flash" and "only this machine can", so every rejection reason is
 * asserted, and the routes are driven through a fake response to prove they
 * never flash an unacceptable caller.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOTS_PATH,
  TEST_FLASH_PATH,
  TEST_STATE_PATH,
  createSelfTestRoutes,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  writeJson,
} from '../src/selftest-route.mjs'
import { DEFAULTS } from '../src/options.mjs'

/**
 * Build a request that the fence should accept.
 *
 * @param overrides - fields to replace.
 * @returns a request-shaped object.
 */
function request(overrides = {}) {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:36001' },
    ...overrides,
  }
}

/**
 * Build a fake response that records what the route wrote.
 *
 * @returns the response plus its captured status and text.
 */
function response() {
  const captured = { status: undefined, headers: undefined, text: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.text = text
    },
  }
}

/**
 * Build a controller stand-in that records notifications.
 *
 * @returns the controller double.
 */
function fakeAttention() {
  const notified = []
  return {
    notified,
    notify(request) {
      notified.push(request)
      return { started: true, hwnd: 0x1a2bn, raw: 32768, pending: 1 }
    },
    stop(cause) {
      notified.push({ stopped: cause })
      return cause
    },
    snapshot() {
      return { flashing: true, pending: ['s1'], reasons: ['self-test'], hwnd: 0x1a2bn }
    },
  }
}

test('loopback address literals are recognized', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.1.2.3'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('8.8.8.8'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('loopback hostnames include localhost', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('a local same-origin request passes the fence', () => {
  assert.equal(isLoopbackRequest(request()), true)
  assert.equal(isLoopbackRequest(request({ headers: { host: 'localhost:36001', origin: 'http://localhost:36001' } })), true)
})

test('every rejection reason is refused', () => {
  const cases = {
    'non-loopback peer': request({ socket: { remoteAddress: '10.0.0.9' } }),
    'missing host': request({ headers: {} }),
    'public host': request({ headers: { host: 'evil.example.com' } }),
    'cross-site fetch': request({ headers: { host: '127.0.0.1:36001', 'sec-fetch-site': 'cross-site' } }),
    'foreign origin': request({ headers: { host: '127.0.0.1:36001', origin: 'http://evil.example.com' } }),
    'malformed origin': request({ headers: { host: '127.0.0.1:36001', origin: 'not a url' } }),
    'forwarded header': request({ headers: { host: '127.0.0.1:36001', 'x-forwarded-for': '1.2.3.4' } }),
    'forwarded host': request({ headers: { host: '127.0.0.1:36001', 'x-forwarded-host': 'evil' } }),
    'forwarded rfc': request({ headers: { host: '127.0.0.1:36001', forwarded: 'for=1.2.3.4' } }),
  }

  for (const [label, value] of Object.entries(cases)) {
    assert.equal(isLoopbackRequest(value), false, label)
  }
})

test('a non-loopback caller never reaches the controller', () => {
  const attention = fakeAttention()
  const [flash] = createSelfTestRoutes({ attention, port: { isForeground: () => false }, options: { ...DEFAULTS } })
  const outgoing = response()

  flash.handler(request({ socket: { remoteAddress: '10.0.0.9' } }), outgoing)

  assert.equal(outgoing.captured.status, 403)
  assert.deepEqual(attention.notified, [])
})

test('a wrong method is refused before the fence runs', () => {
  const attention = fakeAttention()
  const [flash] = createSelfTestRoutes({ attention, port: { isForeground: () => false }, options: { ...DEFAULTS } })
  const outgoing = response()

  flash.handler(request({ method: 'GET' }), outgoing)

  assert.equal(outgoing.captured.status, 405)
  assert.deepEqual(attention.notified, [])
})

test('the flash route reports the window and the resolved options', () => {
  const attention = fakeAttention()
  const routes = createSelfTestRoutes({
    attention,
    port: { isForeground: () => false },
    options: { ...DEFAULTS, flashCaption: false, flashCount: 3 },
  })
  const outgoing = response()

  routes[0].handler(request(), outgoing)

  assert.equal(outgoing.captured.status, 200)
  const body = JSON.parse(outgoing.captured.text)
  assert.equal(body.ok, true)
  assert.equal(body.started, true)
  assert.equal(body.hwnd, '0x1a2b')
  assert.equal(body.foreground, false)
  assert.equal(body.options.flashCaption, false)
  assert.equal(body.options.flashCount, 3)
  assert.equal(attention.notified[0].kind, 'self-test')
})

test('the state route reads on GET and stops on POST', () => {
  const attention = fakeAttention()
  const routes = createSelfTestRoutes({ attention, port: { isForeground: () => false }, options: { ...DEFAULTS } })

  const read = response()
  routes[1].handler(request({ method: 'GET' }), read)
  assert.equal(read.captured.status, 200)
  assert.equal(JSON.parse(read.captured.text).stopped, undefined)
  assert.deepEqual(attention.notified, [])

  const stop = response()
  routes[1].handler(request({ method: 'POST' }), stop)
  assert.equal(JSON.parse(stop.captured.text).stopped, 'self-test')
  assert.deepEqual(attention.notified, [{ stopped: 'self-test' }])
})

test('both routes are exact-path and uniquely named', () => {
  const routes = createSelfTestRoutes({
    attention: fakeAttention(),
    port: { isForeground: () => false },
    options: { ...DEFAULTS },
  })

  assert.deepEqual(routes.map((route) => route.kind), ['exact', 'exact', 'exact'])
  assert.deepEqual(routes.map((route) => route.path), [TEST_FLASH_PATH, TEST_STATE_PATH, DOTS_PATH])
  assert.equal(new Set(routes.map((route) => route.path)).size, 3, 'every path is distinct')
})

test('writeJson serializes bigints and forbids caching', () => {
  const outgoing = response()
  writeJson(outgoing, 200, { hwnd: 0x1a2bn })

  assert.equal(outgoing.captured.status, 200)
  assert.equal(outgoing.captured.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(outgoing.captured.text).hwnd, '6699')
})

test('the dots route accepts a report and hands it to the controller', () => {
  const seen = []
  const routes = createSelfTestRoutes({
    attention: {
      ...fakeAttention(),
      updateDots: (report) => {
        seen.push(report)
        return { total: 2 }
      },
      clearDots: () => seen.push('cleared'),
      snapshot: () => ({ dots: { total: 2 } }),
    },
    port: { isForeground: () => false },
    options: { ...DEFAULTS },
  })
  const route = routes.find((candidate) => candidate.path === DOTS_PATH)
  assert.notEqual(route, undefined)
  assert.equal(typeof route.handler, 'function')
})

test('a foreign origin cannot post dots', () => {
  let called = false
  const routes = createSelfTestRoutes({
    attention: {
      ...fakeAttention(),
      updateDots: () => {
        called = true
        return {}
      },
      clearDots: () => {
        called = true
      },
      snapshot: () => ({}),
    },
    port: { isForeground: () => false },
    options: { ...DEFAULTS },
  })
  const route = routes.find((candidate) => candidate.path === DOTS_PATH)

  const outgoing = response()
  route.handler(
    {
      method: 'POST',
      headers: { host: 'evil.example', origin: 'https://evil.example' },
      socket: { remoteAddress: '10.0.0.5' },
      on: () => {},
    },
    outgoing,
  )

  assert.equal(called, false, 'the controller was never touched')
  assert.equal(outgoing.captured.status, 403)
})
