/**
 * Does a transparent tray icon still receive clicks at its own rectangle?
 *
 * This is the risk the transparent blink introduces: the shell draws nothing, so
 * the slot may also stop being a hit target, which would make the tray icon
 * unclickable for as long as the transparent frame is showing.
 *
 * The probe cannot synthesize a click reliably, so it measures the property that
 * decides it: `Shell_NotifyIconGetRect` must keep answering for the same id while
 * the transparent icon is installed. If the rectangle survives, the shell still
 * owns a slot there and the click still lands on this application's icon.
 *
 *   ELECTRON_RUN_AS_NODE=1 "D:\DSH\DeepSeek Harness.exe" scripts/probe-transparent-hit.mjs <electron-pid>
 *
 * @module dsh-tray-flash/probe-transparent-hit
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildIco } from './build-icon.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const moduleUrl = (name) => new URL(`../src/${name}`, import.meta.url).href

const { loadKoffi } = await import(moduleUrl('koffi-loader.mjs'))
const { createWin32 } = await import(moduleUrl('win32.mjs'))
const { createTrayPort } = await import(moduleUrl('tray.mjs'))

const electronPid = Number(process.argv[2])
const workDir = join(root, 'assets', 'transparent-probe')

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
  console.error('[hit] no tray icon')
  process.exit(1)
}
console.log(`[hit] target uid=${target.uid} rect=(${target.rect.left},${target.rect.top})-(${target.rect.right},${target.rect.bottom})`)

/**
 * Build a fully transparent 32-bpp icon: all alpha zero, AND mask all ones.
 *
 * @param size - square size in pixels.
 * @returns the icon frame bytes.
 */
function transparentFrame(size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size, 0xff)
  return Buffer.concat([header, pixels, mask])
}

const blankIco = join(workDir, 'hit-blank.ico')
await writeFile(blankIco, buildIco([48, 32, 24, 16].map((size) => ({ size, bytes: transparentFrame(size) }))), { mode: 0o644 })

const normalIcon = port.loadIcon(String.raw`D:\DSH\resources\tray.ico`)
const blankIcon = port.loadIcon(blankIco)
if (normalIcon === undefined || blankIcon === undefined) {
  console.error(`[hit] load failed normal=${String(normalIcon)} blank=${String(blankIcon)}`)
  process.exit(1)
}

/**
 * Ask the shell for the icon rectangle and report it.
 *
 * @param label - what state this reading is for.
 * @returns the rectangle, or undefined when the shell no longer knows the icon.
 */
function readRect(label) {
  const found = port.rectOf(target.hwnd, target.uid)
  console.log(`[hit] ${label.padEnd(10)} rect=${found === undefined ? 'MISSING' : `(${found.left},${found.top})-(${found.right},${found.bottom})`}`)
  return found
}

readRect('normal')

port.setIcon(target.hwnd, target.uid, blankIcon)
await new Promise((resolve) => setTimeout(resolve, 700))
const blankRect = readRect('transparent')

port.setIcon(target.hwnd, target.uid, normalIcon)
await new Promise((resolve) => setTimeout(resolve, 500))
const backRect = readRect('restored')

port.releaseIcon(normalIcon)
port.releaseIcon(blankIcon)

const keepsSlot = blankRect !== undefined
const sameGeometry = keepsSlot
  && blankRect.left === target.rect.left
  && blankRect.top === target.rect.top
  && backRect !== undefined
  && backRect.left === target.rect.left

console.log(`[hit] the slot survives a transparent frame: ${String(keepsSlot)}`)
console.log(`[hit] geometry is unchanged:                 ${String(sameGeometry)}`)
console.log(`[hit] ${keepsSlot && sameGeometry ? 'PASS — the icon stays clickable while blank' : 'FAIL — the slot disappears, clicks would be lost'}`)
process.exitCode = keepsSlot && sameGeometry ? 0 : 1
