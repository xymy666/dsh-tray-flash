/**
 * Does the tray blink work while the DSH window holds the foreground?
 *
 * The taskbar button refuses to blink in that state, so this decides whether the
 * "flash even when focused" requirement is satisfiable through the tray. It also
 * measures a DWM border pulse, which is the other foreground-visible option on
 * Windows 11.
 *
 * Run against a live application with DSH already focused:
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-foreground.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-foreground
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
const { createTrayPort } = await import(moduleUrl('tray.mjs'))

const electronPid = Number(process.argv[2])
const outDir = join(root, 'assets', 'foreground-probe')
await mkdir(outDir, { recursive: true })

const { koffi } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
const win = createWin32(koffi)
const trayPort = createTrayPort(koffi, win.user32, win.shell32, win)

const main = win.findMainWindow(electronPid)
if (main === undefined) {
  console.error('[fg] no main window')
  process.exit(1)
}
console.log(`[fg] main window ${String(main.hwnd)} foreground=${String(win.isForeground(main.hwnd))}`)

// --- tray icon ---
let trayTarget
for (const hwnd of trayPort.trayHostWindows([electronPid])) {
  for (let uid = 0; uid <= 8; uid += 1) {
    const rect = trayPort.rectOf(hwnd, uid)
    if (rect !== undefined) trayTarget = { hwnd, uid, rect }
  }
}
if (trayTarget === undefined) {
  console.error('[fg] no tray icon')
  process.exit(1)
}

const captureScript = join(outDir, 'capture.ps1')
await writeFile(captureScript, `
param([string]$Out, [int]$X, [int]$Y, [int]$W, [int]$H)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
$bmp.Save($Out)
$g.Dispose(); $bmp.Dispose()
`, 'utf8')

const shot = async (name, region) => {
  const path = join(outDir, name)
  await run('pwsh', ['-NoProfile', '-File', captureScript, '-Out', path,
    '-X', String(region.left), '-Y', String(region.top),
    '-W', String(region.right - region.left), '-H', String(region.bottom - region.top)], { windowsHide: true })
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

// --- 1. tray icon, while DSH owns the foreground ---
const normalIcon = trayPort.loadIcon(String.raw`D:\DSH\resources\tray.ico`)
const blankIcon = trayPort.loadIcon(join(root, 'assets', 'blank.ico'))
console.log(`[fg] tray icon handles normal=${String(normalIcon)} blank=${String(blankIcon)}`)
if (normalIcon === undefined || blankIcon === undefined) {
  console.error('[fg] an icon failed to load')
  process.exit(1)
}

trayPort.setIcon(trayTarget.hwnd, trayTarget.uid, normalIcon)
await new Promise((resolve) => setTimeout(resolve, 400))
const trayNormal = await shot('tray-normal.png', trayTarget.rect)

trayPort.setIcon(trayTarget.hwnd, trayTarget.uid, blankIcon)
await new Promise((resolve) => setTimeout(resolve, 600))
const trayBlank = await shot('tray-blank.png', trayTarget.rect)

trayPort.setIcon(trayTarget.hwnd, trayTarget.uid, normalIcon)
const trayChanged = await diff(trayNormal, trayBlank)
console.log(`[fg] tray blink while foreground: ${trayChanged} pixels differ -> ${trayChanged > 20 ? 'WORKS' : 'NO EFFECT'}`)

// --- 2. DWM border colour pulse, while DSH owns the foreground ---
const dwmapi = koffi.load('dwmapi.dll')
const user32 = win.user32
const DwmSetWindowAttribute = dwmapi.func('long __stdcall DwmSetWindowAttribute(void* hwnd, uint32 attr, void* value, uint32 size)')
const getWindowRect = user32.func('bool __stdcall GetWindowRect(void* h, void* r)')

/** DWMWA_BORDER_COLOR: draws a 1px accent frame around the whole window. */
const DWMWA_BORDER_COLOR = 34

const rectBuffer = Buffer.alloc(16)
getWindowRect(BigInt(main.hwnd), rectBuffer)
const windowRect = {
  left: rectBuffer.readInt32LE(0),
  top: rectBuffer.readInt32LE(4),
  right: rectBuffer.readInt32LE(8),
  bottom: rectBuffer.readInt32LE(12),
}
console.log(`[fg] window rect ${JSON.stringify(windowRect)}`)

/** Set the accent frame colour, in 0x00BBGGRR form. */
const setBorder = (color) => {
  const value = Buffer.alloc(4)
  value.writeUInt32LE(color, 0)
  return DwmSetWindowAttribute(BigInt(main.hwnd), DWMWA_BORDER_COLOR, value, 4)
}

// Sample a band along the window's own top-left corner, which is where a border
// pulse is visible even for a maximized custom-chrome window.
const borderRegion = {
  left: Math.max(0, windowRect.left),
  top: Math.max(0, windowRect.top),
  right: Math.max(0, windowRect.left) + 220,
  bottom: Math.max(0, windowRect.top) + 60,
}

console.log(`[fg] clearing border -> hr=0x${(setBorder(0xffffffff) >>> 0).toString(16)}`)
await new Promise((resolve) => setTimeout(resolve, 400))
const borderPlain = await shot('border-plain.png', borderRegion)

// 0x00FF8800 is 0x0088FF in 0x00BBGGRR => strong blue in RGB.
console.log(`[fg] setting blue border -> hr=0x${(setBorder(0x00ff8800) >>> 0).toString(16)}`)
await new Promise((resolve) => setTimeout(resolve, 600))
const borderBlue = await shot('border-blue.png', borderRegion)

setBorder(0xffffffff)
const borderChanged = await diff(borderPlain, borderBlue)
console.log(`[fg] DWM border pulse while foreground: ${borderChanged} pixels differ -> ${borderChanged > 20 ? 'WORKS' : 'NO EFFECT'}`)

trayPort.releaseIcon(normalIcon)
trayPort.releaseIcon(blankIcon)
console.log(`[fg] frames in ${outDir}`)
