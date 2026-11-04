/**
 * Reproduce, then disprove, the "green dot but no blink" failure on the live app.
 *
 * The bug was ordering: the Client computes a background session's green dot only
 * after that session's row stops running, which is later than the `turn/end` the
 * Host reacts to. Handling only the event meant the flash was evaluated while no
 * dot existed, and the dot that followed was never acted on.
 *
 * This probe drives the real Host route the Client posts to — `/__tray-flash/dots`
 * — with a dot appearing *after* a turn has already ended, and measures the tray.
 *
 *   node scripts/probe-dot-trigger.mjs [port]
 *
 * @module dsh-tray-flash/probe-dot-trigger
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { decodePng } from './build-icon.mjs'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.argv[2] ?? 34671)
const base = `http://127.0.0.1:${port}`
const outDir = join(root, 'assets', 'dot-trigger')
await mkdir(outDir, { recursive: true })

/** Call one plugin route with the Host header the fence requires. */
async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

/** Read the controller snapshot. */
async function state() {
  const { json } = await call('/__tray-flash/state')
  return json.state
}

// Clear first so the run starts from a known state.
await call('/__tray-flash/dots', 'DELETE')
await call('/__tray-flash/state', 'POST')
await new Promise((resolve) => setTimeout(resolve, 300))

const cleared = await state()
console.log(`[dot] start: flashing=${String(cleared.flashing)} dots=${String(cleared.dots?.total)}`)

// The exact production order: no dots, then a dot appears while nothing flashes.
console.log('[dot] posting a green dot (unread=1) while nothing is flashing')
const posted = await call('/__tray-flash/dots', 'POST', { counts: { unread: 1 } })
console.log(`[dot] route answered ${String(posted.status)} total=${String(posted.json.dots?.total)}`)

await new Promise((resolve) => setTimeout(resolve, 900))
const flashing = await state()
console.log(`[dot] after the report: flashing=${String(flashing.flashing)} lastStop=${String(flashing.lastStop)}`)
console.log(`[dot] tray: ${JSON.stringify(flashing.tray)}`)

// Capture the tray twice, a half blink apart, to see it change on its own.
const tray = flashing.tray?.target
let alternated = 0
if (tray !== undefined) {
  const rect = { x: 1381, y: 1032, w: 32, h: 48 }
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

  const shots = []
  for (let index = 0; index < 10; index += 1) {
    const path = join(outDir, `f${String(index)}.png`)
    await run('pwsh', ['-NoProfile', '-File', captureScript, '-Out', path,
      '-X', String(rect.x), '-Y', String(rect.y), '-W', String(rect.w), '-H', String(rect.h)], { windowsHide: true })
    shots.push(decodePng(await readFile(path)))
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  const base0 = shots[0]
  const levels = shots.map((image) => {
    let changed = 0
    for (let index = 0; index < base0.pixels.length; index += 4) {
      if (Math.abs(base0.pixels[index] - image.pixels[index])
        + Math.abs(base0.pixels[index + 1] - image.pixels[index + 1])
        + Math.abs(base0.pixels[index + 2] - image.pixels[index + 2]) > 20) changed += 1
    }
    return changed
  })
  const bright = levels.map((value) => value > 100)
  alternated = bright.reduce((total, value, index) => (index > 0 && value !== bright[index - 1] ? total + 1 : total), 0)
  console.log(`[dot] tray frames: ${levels.join(',')}`)
  console.log(`[dot] tray alternations while the dot is showing: ${String(alternated)}`)
}

// Clearing the dot must stop it.
await call('/__tray-flash/dots', 'POST', { counts: {} })
await new Promise((resolve) => setTimeout(resolve, 1_400))
const stopped = await state()
console.log(`[dot] after clearing: flashing=${String(stopped.flashing)} lastStop=${String(stopped.lastStop)}`)

const ok = flashing.flashing === true && stopped.flashing === false && stopped.lastStop === 'dots-cleared'
console.log(`[dot] ${ok ? 'PASS — a dot that appears after the turn now starts the flash, and clearing it stops the flash' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
