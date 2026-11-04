/**
 * End-to-end proof of the whole chain, on the live application.
 *
 * Feeds one real Session event into the plugin's real state machine with the real
 * Win32 bindings, then captures the notification area while it runs. This is the
 * only check that covers "a turn ended" → "the tray turned blue", which is the
 * behaviour a person actually sees.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-attention.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-attention
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { decodePng } from './build-icon.mjs'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href

const { loadKoffi } = await import(moduleUrl('koffi-loader.mjs'))
const { createWin32 } = await import(moduleUrl('win32.mjs'))
const { createTrayBlink, createTrayPort } = await import(moduleUrl('tray.mjs'))
const { createAttention } = await import(moduleUrl('attention.mjs'))
const { DEFAULTS } = await import(moduleUrl('options.mjs'))

const electronPid = Number(process.argv[2])
const outDir = join(root, 'assets', 'attention-probe')
await mkdir(outDir, { recursive: true })

const { koffi, label } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
console.log(`[attention] koffi via ${label ?? 'none'} ${koffi?.version ?? ''}`)

const win = createWin32(koffi)
const trayPort = createTrayPort(koffi, win.user32, win.shell32, win)

let target
for (const hwnd of trayPort.trayHostWindows([electronPid])) {
  for (let uid = 0; uid <= 8; uid += 1) {
    const rect = trayPort.rectOf(hwnd, uid)
    if (rect !== undefined) target = { hwnd, uid, rect }
  }
}
if (target === undefined) {
  console.error('[attention] no tray icon found')
  process.exit(1)
}
const { rect } = target
const width = Math.max(8, rect.right - rect.left)
const height = Math.max(8, rect.bottom - rect.top)

const script = join(outDir, 'capture.ps1')
await writeFile(script, `
param([string]$Out, [int]$X, [int]$Y, [int]$W, [int]$H)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
$bmp.Save($Out)
$g.Dispose(); $bmp.Dispose()
`, 'utf8')

const shot = async (name) => {
  const path = join(outDir, name)
  await run('pwsh', ['-NoProfile', '-File', script, '-Out', path,
    '-X', String(rect.left), '-Y', String(rect.top), '-W', String(width), '-H', String(height)], { windowsHide: true })
  return path
}

const diff = async (a, b) => {
  const left = decodePng(await readFile(a))
  const right = decodePng(await readFile(b))
  let changed = 0
  for (let i = 0; i < left.pixels.length; i += 4) {
    if (Math.abs(left.pixels[i] - right.pixels[i])
      + Math.abs(left.pixels[i + 1] - right.pixels[i + 1])
      + Math.abs(left.pixels[i + 2] - right.pixels[i + 2]) > 20) changed += 1
  }
  return changed
}

const tray = createTrayBlink({
  port: trayPort,
  originalIconPath: String.raw`D:\DSH\resources\tray.ico`,
  blankIconPath: join(root, 'assets', 'blank.ico'),
  pids: [electronPid],
  // Frozen long enough that the capture lands inside one state.
  intervalMs: 3_600_000,
  logger: { info: (line) => console.log(`[attention] ${line}`), warn: (line) => console.log(`[attention] ${line}`) },
})

const attention = createAttention({
  port: win,
  options: { ...DEFAULTS, onlyWhenUnfocused: false, maxFlashSeconds: 30, trayBlink: true },
  pids: [electronPid],
  logger: { info: (line) => console.log(`[attention] ${line}`), warn: (line) => console.log(`[attention] ${line}`) },
  tray,
})

const before = await shot('before.png')
console.log(`[attention] before: flashing=${String(attention.snapshot().flashing)}`)

// The real event the Host receives when a turn finishes.
const result = attention.notifyTurnEnd(
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  { id: 'probe-session', header: {} },
)
console.log(`[attention] notifyTurnEnd -> ${JSON.stringify({ ...result, hwnd: result.hwnd === undefined ? undefined : `0x${BigInt(result.hwnd).toString(16)}` })}`)

await new Promise((resolve) => setTimeout(resolve, 900))
const during = await shot('during.png')
const duringState = attention.snapshot()
console.log(`[attention] during: flashing=${String(duringState.flashing)} tray=${JSON.stringify(duringState.tray)}`)

const trayChanged = await diff(before, during)
console.log(`[attention] tray pixels changed while flashing: ${trayChanged}`)

// Simulate the person coming back: the focus poll is what stops it.
attention.stop('probe')
await new Promise((resolve) => setTimeout(resolve, 900))
const after = await shot('after.png')
const restored = await diff(before, after)
console.log(`[attention] tray pixels changed after stop: ${restored} (0 means the icon was restored)`)

attention.dispose()

const ok = result.started === true && trayChanged > 20 && restored === 0
console.log(`[attention] ${ok ? 'PASS — turn/end turned the tray blue and stopping restored it' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
