/**
 * Prove the tray blink is a live alternation, not just two frozen images.
 *
 * Starts the plugin's own controller at a short cadence and samples the icon
 * rectangle while it runs, so the result says whether a person watching the clock
 * would actually see it blink.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-tray-live.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-tray-live
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

const electronPid = Number(process.argv[2])
const intervalMs = Number(process.argv[3] ?? 400)
const outDir = join(root, 'assets', 'live-probe')
await mkdir(outDir, { recursive: true })

const { koffi } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
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
  console.error('[live] no tray icon')
  process.exit(1)
}
const { rect } = target
const width = rect.right - rect.left
const height = rect.bottom - rect.top
console.log(`[live] tray icon ${width}x${height} at (${rect.left},${rect.top}), cadence ${intervalMs}ms`)

const captureScript = join(outDir, 'capture.ps1')
await writeFile(captureScript, `
param([string]$Prefix, [int]$Count, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$Gap)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
for ($i = 0; $i -lt $Count; $i++) {
  $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
  $bmp.Save("$Prefix$i.png")
  Start-Sleep -Milliseconds $Gap
}
$g.Dispose(); $bmp.Dispose()
`, 'utf8')

const tray = createTrayBlink({
  port: trayPort,
  originalIconPath: String.raw`D:\DSH\resources\tray.ico`,
  blankIconPath: join(root, 'assets', 'blank.ico'),
  pids: [electronPid],
  intervalMs,
  logger: { info: (line) => console.log(`[live] ${line}`), warn: (line) => console.log(`[live] ${line}`) },
})

const count = 36
const gap = Math.max(60, Math.round(intervalMs / 3))
console.log(`[live] start -> ${String(tray.start())}`)
// Sample in a separate process while the controller keeps flipping the icon.
const capture = run('pwsh', ['-NoProfile', '-File', captureScript,
  '-Prefix', join(outDir, 'f'), '-Count', String(count),
  '-X', String(rect.left), '-Y', String(rect.top), '-W', String(width), '-H', String(height),
  '-Gap', String(gap)], { windowsHide: true })
await capture
tray.stop()
tray.dispose()

const frames = []
for (let index = 0; index < count; index += 1) {
  const path = join(outDir, `f${index}.png`)
  try {
    frames.push({ index, image: decodePng(await readFile(path)) })
  } catch {
    // A frame that failed to write is skipped rather than counted as a state.
  }
}

const base = frames[0].image
const states = frames.map((frame) => {
  let changed = 0
  for (let i = 0; i < base.pixels.length; i += 4) {
    if (Math.abs(base.pixels[i] - frame.image.pixels[i])
      + Math.abs(base.pixels[i + 1] - frame.image.pixels[i + 1])
      + Math.abs(base.pixels[i + 2] - frame.image.pixels[i + 2]) > 20) changed += 1
  }
  return changed
})

const bright = states.map((value) => value > 100)
const flips = bright.reduce((total, value, index) => (index > 0 && value !== bright[index - 1] ? total + 1 : total), 0)
console.log(`[live] per-frame change: ${states.join(',')}`)
console.log(`[live] pattern: ${bright.map((value) => (value ? '#' : '.')).join('')}`)
console.log(`[live] flips: ${flips}, bright frames: ${bright.filter(Boolean).length}/${bright.length}`)
console.log(`[live] ${flips >= 3 ? 'PASS — the icon really alternates' : 'FAIL — the icon does not alternate'}`)
process.exitCode = flips >= 3 ? 0 : 1
