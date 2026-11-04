/**
 * Manual end-to-end probe for the tray blink, run under the app's own Electron
 * Node runtime against the live application.
 *
 * Not part of the test suite: it needs a running DeepSeek Harness and it changes
 * a real tray icon for a moment. It exists so the tray path can be re-verified
 * after an application update, which is the one thing unit tests cannot cover.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-tray.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-tray
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href

const { loadKoffi } = await import(moduleUrl('koffi-loader.mjs'))
const { createWin32 } = await import(moduleUrl('win32.mjs'))
const { createTrayBlink, createTrayPort } = await import(moduleUrl('tray.mjs'))

const electronPid = Number(process.argv[2])
if (!Number.isInteger(electronPid) || electronPid <= 0) {
  console.error('usage: probe-tray.mjs <electron-pid>')
  process.exit(2)
}

const { koffi, label } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
console.log(`[probe] koffi via ${label ?? 'none'} ${koffi?.version ?? ''}`)
if (koffi === undefined) process.exit(1)

const win = createWin32(koffi)
const trayPort = createTrayPort(koffi, win.user32, win.shell32, win)

const hosts = trayPort.trayHostWindows([electronPid])
console.log(`[probe] tray host windows: ${hosts.map(String).join(', ') || '(none)'}`)
for (const hwnd of hosts) {
  for (let uid = 0; uid <= 8; uid += 1) {
    const rect = trayPort.rectOf(hwnd, uid)
    if (rect !== undefined) console.log(`[probe]   icon uid=${uid} at (${rect.left},${rect.top})-(${rect.right},${rect.bottom})`)
  }
}

const originalIconPath = String.raw`D:\DSH\resources\tray.ico`
const blankIconPath = String.raw`${root}\assets\blank.ico`
console.log(`[probe] blank icon: ${blankIconPath}`)

for (const path of [originalIconPath, blankIconPath]) {
  const icon = trayPort.loadIcon(path)
  console.log(`[probe] loadIcon ${path} -> ${icon === undefined ? 'UNDEFINED' : String(icon)}`)
  if (icon !== undefined) trayPort.releaseIcon(icon)
}

const tray = createTrayBlink({
  port: trayPort,
  originalIconPath,
  blankIconPath,
  pids: [electronPid],
  intervalMs: 400,
  logger: { info: (line) => console.log(`[probe] ${line}`), warn: (line) => console.log(`[probe] ${line}`) },
})

console.log(`[probe] start -> ${String(tray.start())}`)
console.log(`[probe] snapshot -> ${JSON.stringify(tray.snapshot())}`)
await new Promise((resolve) => setTimeout(resolve, 700))
tray.tick()
tray.tick()
console.log(`[probe] after two ticks -> ${JSON.stringify(tray.snapshot())}`)
console.log(`[probe] stop -> ${String(tray.stop())}`)
tray.dispose()
console.log('[probe] disposed')
