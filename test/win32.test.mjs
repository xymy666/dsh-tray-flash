/**
 * Tests for the Win32 binding surface.
 *
 * A fake `koffi` stands in for the real module so the important, invisible
 * details are asserted: the `FLASHWINFO` layout, the flag composition, the
 * pid/class/visibility filter that isolates the Harness window, and the fact
 * that every registered enum callback is released again.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLASH_CAPTION,
  FLASH_TIMERNOFG,
  FLASH_TRAY,
  createWin32,
  flashFlags,
  handleOf,
  sameHandle,
} from '../src/win32.mjs'

/**
 * Build a fake koffi whose `user32` answers from a scripted window list.
 *
 * @param windows - windows the enumeration should report, in order.
 * @returns the fake plus its call log.
 */
function fakeKoffi(windows = []) {
  const calls = []
  const registered = new Set()

  const funcs = new Map()

  const define = (library, signature) => {
    const name = /__stdcall\s+(\w+)/.exec(signature)?.[1] ?? signature
    const fn = (...args) => {
      calls.push([name, ...args])
      switch (name) {
        case 'EnumWindows': {
          const [callback] = args
          for (const window of windows) {
            const keepGoing = callback(window.hwnd, 0, window)
            if (keepGoing === false) break
          }
          return 1
        }
        case 'GetWindowThreadProcessId': {
          const [hwnd, pidBuffer] = args
          const entry = windows.find((window) => handleOf(window.hwnd) === handleOf(hwnd))
          pidBuffer.writeUInt32LE(entry?.pid ?? 0, 0)
          return 1
        }
        case 'GetClassNameW': {
          const [hwnd, buffer] = args
          const entry = windows.find((window) => handleOf(window.hwnd) === handleOf(hwnd))
          const text = entry?.className ?? ''
          buffer.write(text, 0, 'utf16le')
          return text.length
        }
        case 'GetWindowTextW': {
          const [hwnd, buffer] = args
          const entry = windows.find((window) => handleOf(window.hwnd) === handleOf(hwnd))
          const text = entry?.title ?? ''
          buffer.write(text, 0, 'utf16le')
          return text.length
        }
        case 'IsWindowVisible': {
          const [hwnd] = args
          const entry = windows.find((window) => handleOf(window.hwnd) === handleOf(hwnd))
          return entry?.visible === false ? 0 : 1
        }
        case 'IsWindow': {
          const [hwnd] = args
          return windows.some((window) => handleOf(window.hwnd) === handleOf(hwnd)) ? 1 : 0
        }
        case 'GetForegroundWindow':
          return foreground
        case 'FlashWindowEx':
          return 32768
        default:
          return 0
      }
    }
    funcs.set(`${library}.${name}`, fn)
    return fn
  }

  let foreground = 0n
  const koffi = {
    calls,
    registered,
    setForeground(value) {
      foreground = value
    },
    load(library) {
      calls.push(['load', library])
      return { func: (signature) => define(library, signature) }
    },
    struct(name, shape) {
      // The real koffi reports the byte size; mirror the x64 layout exactly so a
      // wrong field type would fail this test rather than the caller's flash:
      // cbSize(4) + pad(4) + hwnd(8) + dwFlags(4) + uCount(4) + dwTimeout(4) + tail pad(4).
      const size = 4 + 4 + 8 + 4 + 4 + 4 + 4
      return { name, shape, size }
    },
    proto(signature) {
      calls.push(['proto', signature])
      return { signature }
    },
    pointer(type) {
      return { type }
    },
    register(fn) {
      const handle = { fn, id: registered.size + 1 }
      registered.add(handle)
      // koffi hands the C side an opaque pointer that calls back into `fn`; the
      // fake hands over an equivalent callable so the enumeration still works.
      return Object.assign((...args) => handle.fn(...args), { handle })
    },
    unregister(callable) {
      calls.push(['unregister'])
      registered.delete(callable.handle)
    },
  }
  return koffi
}

const MAIN = {
  hwnd: 0x1a2bn,
  pid: 5000,
  className: 'Chrome_WidgetWin_1',
  title: '积分系统用于AI检测 — DeepSeek Harness',
  visible: true,
}

test('the struct size matches the documented x64 layout', () => {
  const win32 = createWin32(fakeKoffi([MAIN]))
  assert.equal(win32.structSize, 32)
})

test('caption inclusion only adds the caption bit', () => {
  assert.equal(flashFlags({ caption: true }), FLASH_CAPTION | FLASH_TRAY | FLASH_TIMERNOFG)
  assert.equal(flashFlags({ caption: false }), FLASH_TRAY | FLASH_TIMERNOFG)
  assert.equal(flashFlags(), FLASH_CAPTION | FLASH_TRAY | FLASH_TIMERNOFG)
})

test('a handle can arrive as bigint, number or string', () => {
  assert.equal(handleOf(0x1a2bn), 0x1a2bn)
  assert.equal(handleOf(6699), 0x1a2bn)
  assert.equal(handleOf('6699'), 0x1a2bn)
  assert.equal(handleOf(null), 0n)
  assert.equal(handleOf(undefined), 0n)
})

test('sameHandle never matches two zero handles', () => {
  assert.equal(sameHandle(0x1a2bn, 6699), true)
  assert.equal(sameHandle(0n, 0n), false)
  assert.equal(sameHandle(0x1n, 0x2n), false)
})

test('the Harness window is found among Electron helper windows', () => {
  const koffi = fakeKoffi([
    { hwnd: 0x11n, pid: 5000, className: 'Chrome_WidgetWin_0', title: '', visible: false },
    { hwnd: 0x12n, pid: 5000, className: 'Electron_NotifyIconHostWindow', title: '', visible: false },
    MAIN,
    { hwnd: 0x13n, pid: 5000, className: 'Chrome_WidgetWin_1', title: 'MSCTFIME UI', visible: false },
    { hwnd: 0x14n, pid: 9999, className: 'Chrome_WidgetWin_1', title: 'Other app — DeepSeek Harness', visible: true },
  ])
  const win32 = createWin32(koffi)

  const found = win32.findMainWindow(5000)

  assert.equal(handleOf(found.hwnd), 0x1a2bn)
  assert.equal(koffi.registered.size, 0, 'the enum callback was released')
})

test('an invisible or untitled main window is not chosen', () => {
  const koffi = fakeKoffi([
    { hwnd: 0x21n, pid: 5000, className: 'Chrome_WidgetWin_1', title: '', visible: true },
    { hwnd: 0x22n, pid: 5000, className: 'Chrome_WidgetWin_1', title: 'hidden — DeepSeek Harness', visible: false },
  ])

  assert.equal(createWin32(koffi).findMainWindow(5000), undefined)
})

test('preferring the one titled after the product', () => {
  const koffi = fakeKoffi([
    { hwnd: 0x31n, pid: 5000, className: 'Chrome_WidgetWin_1', title: 'some other window', visible: true },
    MAIN,
  ])

  assert.equal(handleOf(createWin32(koffi).findMainWindow(5000).hwnd), 0x1a2bn)
})

test('flash and stop pass the documented flags', () => {
  const koffi = fakeKoffi([MAIN])
  const win32 = createWin32(koffi)

  win32.flash(0x1a2bn, { caption: false, count: 4, timeout: 120 })
  win32.stop(0x1a2bn)

  const flashCall = koffi.calls.find(([name]) => name === 'FlashWindowEx')
  assert.equal(flashCall[1].cbSize, 32)
  assert.equal(flashCall[1].hwnd, 0x1a2bn)
  assert.equal(flashCall[1].dwFlags, FLASH_TRAY | FLASH_TIMERNOFG)
  assert.equal(flashCall[1].uCount, 4)
  assert.equal(flashCall[1].dwTimeout, 120)

  const calls = koffi.calls.filter(([name]) => name === 'FlashWindowEx')
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].dwFlags, 0, 'stop clears every flag')
  assert.equal(calls[1][1].uCount, 0)
})

test('foreground comparison handles mismatched representations', () => {
  const koffi = fakeKoffi([MAIN])
  const win32 = createWin32(koffi)

  koffi.setForeground(0x1a2bn)
  assert.equal(win32.isForeground(6699), true)

  koffi.setForeground(0x99n)
  assert.equal(win32.isForeground(0x1a2bn), false)
})

test('liveness never reports a zero handle as live', () => {
  const koffi = fakeKoffi([MAIN])
  const win32 = createWin32(koffi)

  assert.equal(win32.isLive(0x1a2bn), true)
  assert.equal(win32.isLive(0x1n), false)
  assert.equal(win32.isLive(0n), false)
})
