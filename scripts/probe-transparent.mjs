/**
 * Does a fully transparent icon actually blank the notification-area slot?
 *
 * The user wants the tray icon to alternate between the real icon and *nothing*,
 * the way QQ blinks. That only works if the shell renders a 32-bpp ICO whose
 * alpha channel is zero as empty space rather than as a black or white square, so
 * this measures it instead of assuming.
 *
 * Three candidates are compared against the real icon:
 *
 * - `alpha0` — 32-bpp DIB, all alpha zero, AND mask all ones (the AND mask is the
 *   pre-alpha mechanism, so both are cleared to be safe).
 * - `andmask` — 32-bpp DIB, alpha 255 but AND mask all ones (opaque image, mask
 *   hides it). Included because some shells honour the mask over the alpha.
 * - `1bit` — a 1-bpp icon, the classic "no image" form.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-transparent.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-transparent
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { buildIco, decodePng } from './build-icon.mjs'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href

const { loadKoffi } = await import(moduleUrl('koffi-loader.mjs'))
const { createWin32 } = await import(moduleUrl('win32.mjs'))
const { createTrayPort } = await import(moduleUrl('tray.mjs'))

const electronPid = Number(process.argv[2])
const outDir = join(root, 'assets', 'transparent-probe')
await mkdir(outDir, { recursive: true })

const { koffi } = loadKoffi({
  resourcesPath: String.raw`D:\DSH\resources`,
  execPath: String.raw`D:\DSH\DeepSeek Harness.exe`,
})
const win = createWin32(koffi)
const port = createTrayPort(koffi, win.user32, win.shell32, win)

let target
for (const hwnd of port.trayHostWindows([electronPid])) {
  for (let uid = 0; uid <= 8; uid += 1) {
    const rect = port.rectOf(hwnd, uid)
    if (rect !== undefined) target = { hwnd, uid, rect }
  }
}
if (target === undefined) {
  console.error('[transparent] no tray icon')
  process.exit(1)
}
const { rect } = target
const width = rect.right - rect.left
const height = rect.bottom - rect.top
console.log(`[transparent] tray icon ${width}x${height} at (${rect.left},${rect.top})`)

/**
 * Build a 32-bpp DIB icon frame.
 *
 * @param size - square size in pixels.
 * @param alpha - alpha value for every pixel.
 * @param maskedOut - whether the AND mask marks every pixel transparent.
 * @returns the icon frame bytes.
 */
function dibIcon(size, alpha, maskedOut) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(size * size * 4, 20)

  // Zeroed colour data: fully transparent black, bottom-up.
  const pixels = Buffer.alloc(size * size * 4)
  if (alpha !== 0) {
    for (let index = 0; index < size * size; index += 1) pixels[index * 4 + 3] = alpha
  }

  // 1 bit per pixel, rows padded to 4 bytes. All ones = every pixel masked out.
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size, maskedOut ? 0xff : 0x00)

  return Buffer.concat([header, pixels, mask])
}

/**
 * Build a 1-bpp icon frame, the smallest "blank" form.
 *
 * @param size - square size in pixels.
 * @returns the icon frame bytes.
 */
function oneBitIcon(size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(1, 14)
  header.writeUInt32LE(0, 16)
  const xorStride = Math.ceil(size / 32) * 4
  header.writeUInt32LE(xorStride * size, 20)

  const palette = Buffer.alloc(8) // black and white
  palette.writeUInt32LE(0x000000, 0)
  palette.writeUInt32LE(0xffffff, 4)
  // XOR data all zero = palette index 0 = black; the AND mask hides it anyway.
  const xor = Buffer.alloc(xorStride * size, 0x00)
  const mask = Buffer.alloc(xorStride * size, 0xff)

  return Buffer.concat([header, palette, xor, mask])
}

const candidates = {
  alpha0: buildIco([48, 32, 24, 16].map((size) => ({ size, bytes: dibIcon(size, 0, true) }))),
  andmask: buildIco([48, 32, 24, 16].map((size) => ({ size, bytes: dibIcon(size, 255, true) }))),
  '1bit': buildIco([48, 32, 24, 16].map((size) => ({ size, bytes: oneBitIcon(size) }))),
}

for (const [name, bytes] of Object.entries(candidates)) {
  await writeFile(join(outDir, `${name}.ico`), bytes)
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

const shot = async (name) => {
  const path = join(outDir, name)
  await run('pwsh', ['-NoProfile', '-File', captureScript, '-Out', path,
    '-X', String(rect.left), '-Y', String(rect.top), '-W', String(width), '-H', String(height)], { windowsHide: true })
  return path
}

/**
 * How much the icon area differs from two captures, plus how much non-background
 * content is visible. The second number is what tells "blank" from "changed".
 *
 * @param a - first PNG path.
 * @param b - second PNG path.
 * @returns the pixel difference and the visible-pixel count of `b`.
 */
async function compare(a, b) {
  const left = decodePng(await readFile(a))
  const right = decodePng(await readFile(b))
  let changed = 0
  for (let index = 0; index < left.pixels.length; index += 4) {
    if (Math.abs(left.pixels[index] - right.pixels[index])
      + Math.abs(left.pixels[index + 1] - right.pixels[index + 1])
      + Math.abs(left.pixels[index + 2] - right.pixels[index + 2]) > 20) changed += 1
  }
  return changed
}

const normalIcon = port.loadIcon(String.raw`D:\DSH\resources\tray.ico`)
port.setIcon(target.hwnd, target.uid, normalIcon)
await new Promise((resolve) => setTimeout(resolve, 500))
const baseline = await shot('baseline-normal.png')

for (const [name, bytes] of Object.entries(candidates)) {
  const path = join(outDir, `${name}.ico`)
  const icon = port.loadIcon(path)
  if (icon === undefined) {
    console.log(`[transparent] ${name}: LoadImageW FAILED`)
    continue
  }
  const accepted = port.setIcon(target.hwnd, target.uid, icon)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const after = await shot(`state-${name}.png`)
  const changed = await compare(baseline, after)
  console.log(`[transparent] ${name}: shell=${String(accepted)} changedPixels=${changed}`)
  port.releaseIcon(icon)
  port.setIcon(target.hwnd, target.uid, normalIcon)
  await new Promise((resolve) => setTimeout(resolve, 300))
}

port.setIcon(target.hwnd, target.uid, normalIcon)
port.releaseIcon(normalIcon)
console.log(`[transparent] frames in ${outDir}`)
