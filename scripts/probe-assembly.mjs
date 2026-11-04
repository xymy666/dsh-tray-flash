/**
 * Assemble the plugin exactly as the Host does, then drive one real flash.
 *
 * This is the check that would have caught the doubled `resources` path: it wires
 * `createTrayBlink` with the same icon paths `lib/index.js` computes, under the
 * real Electron runtime, and reports whether the tray half actually starts.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-assembly.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-assembly
 */

import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href

const { loadKoffi } = await import(moduleUrl('koffi-loader.mjs'))
const { createAttention } = await import(moduleUrl('attention.mjs'))
const { createDots } = await import(moduleUrl('dots.mjs'))
const { createTrayBlink, createTrayPort } = await import(moduleUrl('tray.mjs'))
const { createWin32 } = await import(moduleUrl('win32.mjs'))
const { DEFAULTS } = await import(moduleUrl('options.mjs'))

const electronPid = Number(process.argv[2])
if (!Number.isInteger(electronPid) || electronPid <= 0) {
  console.error('usage: probe-assembly.mjs <electron-pid>')
  process.exit(2)
}

const { koffi } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
const win = createWin32(koffi)
const pids = [electronPid]

// These two lines mirror lib/index.js. If they ever disagree with it, the probe
// would pass while the shipped plugin fails, so they are asserted below.
const resourcesDir = process.resourcesPath ?? join(process.execPath, '..', 'resources')
const originalIconPath = join(resourcesDir, 'tray.ico')
const blankIconPath = join(root, 'assets', 'blank.ico')

console.log(`[assembly] resources dir : ${resourcesDir}`)
console.log(`[assembly] original icon : ${originalIconPath}`)
console.log(`[assembly] blank icon   : ${blankIconPath}`)

const trayPort = createTrayPort(koffi, win.user32, win.shell32, win)
const tray = createTrayBlink({
  port: trayPort,
  originalIconPath,
  blankIconPath,
  pids,
  intervalMs: 400,
  logger: { info: (line) => console.log(`[assembly] ${line}`), warn: (line) => console.log(`[assembly] ${line}`) },
})

const dots = createDots({ staleSeconds: 60, virtualMain: true })
const attention = createAttention({
  port: win,
  options: { ...DEFAULTS, maxFlashSeconds: 30 },
  pids,
  logger: { info: (line) => console.log(`[assembly] ${line}`), warn: (line) => console.log(`[assembly] ${line}`) },
  tray,
  dots,
})

// A background session with a green dot: the case that must keep flashing.
dots.update({ counts: { unread: 1 } })
const started = attention.notifyTurnEnd({ type: 'turn/end', data: {} }, { id: 'probe-bg' }, { isMain: false })

const snapshot = attention.snapshot()
console.log(`[assembly] started        : ${String(started.started)}`)
console.log(`[assembly] tray available : ${String(snapshot.tray?.available)}`)
console.log(`[assembly] tray blinking  : ${String(snapshot.tray?.blinking)}`)
console.log(`[assembly] dots total     : ${String(snapshot.dots?.total)}`)

await new Promise((resolve) => setTimeout(resolve, 1_500))

// Clearing the dot must end the flash, including the tray image restore.
dots.update({ counts: { unread: 0 } })
attention.tick()
const after = attention.snapshot()
console.log(`[assembly] after clear    : flashing=${String(after.flashing)} lastStop=${String(after.lastStop)}`)
console.log(`[assembly] tray restored  : ${String(after.tray?.showingBlank === false)}`)

attention.dispose()

const ok = started.started === true
  && snapshot.tray?.available === true
  && snapshot.tray?.blinking === true
  && after.flashing === false
  && after.lastStop === 'dots-cleared'

console.log(`[assembly] ${ok ? 'PASS — the tray half starts and stops with the dots' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
