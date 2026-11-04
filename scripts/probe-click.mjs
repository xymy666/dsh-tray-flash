/**
 * Choose the "the user clicked" detector by measuring two candidates.
 *
 * The requirement is to stop blinking on the user's next mouse click, which is
 * not the same as "any input" and must not be missed by an unlucky poll. This
 * probe drives a synthetic click through SendInput and reports which signal saw
 * it, so the plugin's stop rule rests on a measurement.
 *
 *   node scripts/probe-click.mjs
 *
 * @module dsh-tray-flash/probe-click
 */

import { createRequire } from 'node:module'

const requireFromHost = createRequire(String.raw`D:\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`)
const koffi = requireFromHost('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const LASTINPUTINFO = koffi.struct('PROBE_CLICK_LASTINPUTINFO', {
  cbSize: 'uint32',
  dwTime: 'uint32',
})

const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(PROBE_CLICK_LASTINPUTINFO* info)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)')
const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()')
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, uintptr_t extra)')

const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

const BUTTONS = [
  ['left', 1],
  ['right', 2],
  ['middle', 4],
  ['x1', 5],
  ['x2', 6],
]

const info = { cbSize: LASTINPUTINFO.size, dwTime: 0 }
let previousIdle = 0
const events = []

/**
 * One poll: report the idle time and any latched button press.
 *
 * @param label - what this poll is for, in the log.
 */
function poll(label) {
  GetLastInputInfo(info)
  const idle = ((GetTickCount() - info.dwTime) >>> 0)
  const latched = BUTTONS
    .filter(([, key]) => (GetAsyncKeyState(key) & 1) !== 0)
    .map(([name]) => name)
  const down = BUTTONS
    .filter(([, key]) => (GetAsyncKeyState(key) & 0x8000) !== 0)
    .map(([name]) => name)
  const idleReset = idle < previousIdle
  previousIdle = idle
  if (latched.length > 0 || down.length > 0 || idleReset) {
    events.push({ label, idle, latched, down, idleReset })
  }
  console.log(`[click] ${label.padEnd(18)} idle=${String(idle).padStart(6)}ms idleReset=${String(idleReset).padEnd(5)} latched=${latched.join(',') || '-'} down=${down.join(',') || '-'}`)
}

// Baseline: no input expected here.
poll('baseline')

// A synthetic click, which is exactly what the latch is supposed to catch.
console.log('[click] sending a synthetic left click')
mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
poll('during synthetic')
mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)

// A short burst afterwards shows how the latch clears itself.
for (let index = 0; index < 4; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  poll(`after ${String(index + 1)}`)
}

const caughtByLatch = events.some((event) => event.latched.includes('left'))
const caughtByDown = events.some((event) => event.down.includes('left'))
console.log(`[click] latch caught the click: ${caughtByLatch}`)
console.log(`[click] live down-state caught it: ${caughtByDown}`)
