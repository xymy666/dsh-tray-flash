/**
 * Confirm that the two blink states are exactly "the real icon" and "nothing".
 *
 * `probe-tray-live.mjs` proves the icon alternates; it does not prove *what* it
 * alternates to. A black square would also alternate. This probe freezes each
 * state, captures it, and compares against a reference capture of bare taskbar
 * background taken from a neighbouring slot, so "empty" is measured against the
 * taskbar itself rather than against a guess.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts\probe-blank-states.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-blank-states
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
const outDir = join(root, 'assets', 'blank-states')
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
  console.error('[states] no tray icon')
  process.exit(1)
}
const { rect } = target
const width = rect.right - rect.left
const height = rect.bottom - rect.top

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

/**
 * Capture one rectangle.
 *
 * @param name - file name.
 * @param region - `{ left, top, right, bottom }`.
 * @returns the PNG path.
 */
async function shot(name, region) {
  const path = join(outDir, name)
  await run('pwsh', ['-NoProfile', '-File', captureScript, '-Out', path,
    '-X', String(region.left), '-Y', String(region.top),
    '-W', String(region.right - region.left), '-H', String(region.bottom - region.top)], { windowsHide: true })
  return path
}

/**
 * Count pixels that differ between two captures by more than a threshold.
 *
 * @param a - first PNG path.
 * @param b - second PNG path.
 * @returns the differing pixel count.
 */
async function diff(a, b) {
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

/**
 * Count "ink" pixels: how far the capture departs from the taskbar's own
 * background.
 *
 * The tray region includes the taskbar's top edge, which is a lighter strip across
 * every slot. Measuring against the whole-region median therefore counts that edge
 * as drawn content. The comparison is confined to the icon's own square instead:
 * the shell reports a slot taller than the glyph (32x48 here, glyph in the middle),
 * so only the central band is examined and the surrounding bar is ignored.
 *
 * @param path - PNG path.
 * @returns the ink pixel count inside the icon area.
 */
async function ink(path) {
  const image = decodePng(await readFile(path))
  const { width, height, pixels } = image

  // The icon is square and sits in the vertical middle of the reported slot.
  const side = Math.min(width, height)
  const top = Math.floor((height - side) / 2)
  const left = Math.floor((width - side) / 2)

  const samples = []
  for (let y = top; y < top + side; y += 1) {
    for (let x = left; x < left + side; x += 1) {
      const index = (y * width + x) * 4
      samples.push(pixels[index] + pixels[index + 1] + pixels[index + 2])
    }
  }
  samples.sort((a, b) => a - b)
  const background = samples[Math.floor(samples.length / 2)]

  let count = 0
  for (const value of samples) if (Math.abs(value - background) > 60) count += 1
  return count
}

const normalIcon = port.loadIcon(String.raw`D:\DSH\resources\tray.ico`)
const blankIcon = port.loadIcon(join(root, 'assets', 'blank.ico'))
if (normalIcon === undefined || blankIcon === undefined) {
  console.error(`[states] load failed normal=${String(normalIcon)} blank=${String(blankIcon)}`)
  process.exit(1)
}

// Freeze each state and capture it. The timer is never started: the two states are
// set explicitly so the screenshot cannot land mid-flip.
port.setIcon(target.hwnd, target.uid, normalIcon)
await new Promise((resolve) => setTimeout(resolve, 700))
const normalShot = await shot('state-normal.png', rect)

port.setIcon(target.hwnd, target.uid, blankIcon)
await new Promise((resolve) => setTimeout(resolve, 700))
const blankShot = await shot('state-blank.png', rect)

port.setIcon(target.hwnd, target.uid, normalIcon)
port.releaseIcon(normalIcon)
port.releaseIcon(blankIcon)

const changed = await diff(normalShot, blankShot)
const normalInk = await ink(normalShot)
const blankInk = await ink(blankShot)

console.log(`[states] tray region ${width}x${height}`)
console.log(`[states] ink with the real icon : ${normalInk}`)
console.log(`[states] ink with the blank icon: ${blankInk}`)
console.log(`[states] pixels differing        : ${changed}`)

const realIconVisible = normalInk > 40
const blankIsEmpty = blankInk === 0
console.log(`[states] the real icon draws something: ${String(realIconVisible)}`)
console.log(`[states] the blank frame draws nothing: ${String(blankIsEmpty)}`)
console.log(`[states] ${realIconVisible && blankIsEmpty && changed > 40 ? 'PASS — it alternates between the icon and nothing' : 'FAIL'}`)
process.exitCode = realIconVisible && blankIsEmpty && changed > 40 ? 0 : 1
