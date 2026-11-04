#!/usr/bin/env node
/**
 * End-to-end acceptance for `dsh-tray-flash`.
 *
 * The plugin's whole promise is "the taskbar blinks", which no in-process
 * assertion can observe. This script drives the Host's self-test route, captures
 * the taskbar strip repeatedly, and measures how many pixels change between
 * frames. A flash is a periodic, large change; an idle taskbar's only noise is
 * the analog clock (measured at 10–50 px), so the threshold is set well above it.
 *
 * Usage:
 *   node scripts/selftest.mjs [port]
 *
 * Exit codes: 0 = a flash was observed, 1 = no flash, 2 = the route refused.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Minimum changed pixels between two frames that counts as a flash. */
const FLASH_PIXEL_THRESHOLD = 300

/** How many frames to sample. */
const FRAME_COUNT = 14

/** Delay between frames, in milliseconds. */
const FRAME_DELAY_MS = 110

/**
 * Parse `argv` into a port and options.
 *
 * @param argv - process arguments after the script path.
 * @returns the resolved settings.
 */
function parseArgs(argv) {
  let port = 36001
  for (const arg of argv) {
    if (/^\d+$/.test(arg)) port = Number(arg)
  }
  return { port }
}

/**
 * Call one self-test route.
 *
 * @param port - Host port.
 * @param path - route path.
 * @param method - HTTP method.
 * @returns the parsed JSON body, or a structured failure.
 */
async function callRoute(port, path, method) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}` },
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 400) }
    }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Read the virtual-screen bounds and working area through PowerShell.
 *
 * @returns the capture rectangle in screen coordinates.
 */
async function taskbarRect() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen
$b = $s.Bounds
$w = $s.WorkingArea
[pscustomobject]@{ x = $b.X; y = ($b.Y + $w.Height); width = $b.Width; height = ($b.Height - $w.Height) } |
  ConvertTo-Json -Compress
`
  const { stdout } = await run('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true })
  return JSON.parse(stdout.trim())
}

/**
 * Capture N frames of one screen rectangle as PNG files.
 *
 * @param rect - screen rectangle.
 * @param directory - destination directory.
 * @param count - frame count.
 * @param delayMs - delay between frames.
 * @returns the written frame paths.
 */
async function captureFrames(rect, directory, count, delayMs) {
  const script = `
param([string]$Prefix, [int]$Count, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$Delay)
Add-Type -AssemblyName System.Drawing
for ($i = 0; $i -lt $Count; $i++) {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
  $bmp.Save("$Prefix$i.png")
  $g.Dispose(); $bmp.Dispose()
  Start-Sleep -Milliseconds $Delay
}
`
  const scriptPath = join(directory, 'capture.ps1')
  await writeFile(scriptPath, script, 'utf8')
  await run('pwsh', [
    '-NoProfile', '-File', scriptPath,
    '-Prefix', join(directory, 'frame-'),
    '-Count', String(count),
    '-X', String(rect.x), '-Y', String(rect.y),
    '-W', String(rect.width), '-H', String(rect.height),
    '-Delay', String(delayMs),
  ], { windowsHide: true })

  return Array.from({ length: count }, (_value, index) => join(directory, `frame-${index}.png`))
}

/**
 * Compare every frame against the first and report the changed-pixel counts.
 *
 * Uses the bundled Python (Pillow) because a PNG decode in pure JS would need a
 * dependency this package deliberately does not have.
 *
 * @param paths - frame paths.
 * @returns per-frame changed-pixel counts.
 */
async function diffFrames(paths) {
  const script = `
import json, sys
from PIL import Image, ImageChops
base = Image.open(sys.argv[1]).convert('RGB')
result = []
for path in sys.argv[2:]:
    frame = Image.open(path).convert('RGB')
    diff = ImageChops.difference(base, frame)
    changed = sum(1 for pixel in diff.getdata() if sum(pixel) > 25)
    result.append({'file': path.rsplit('/', 1)[-1], 'changed': changed, 'bbox': diff.getbbox()})
print(json.dumps(result))
`
  const scriptPath = join(tmpdir(), `tray-flash-diff-${process.pid}.py`)
  await writeFile(scriptPath, script, 'utf8')
  try {
    const { stdout } = await run('python', [scriptPath, ...paths], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(stdout.trim())
  } finally {
    await rm(scriptPath, { force: true })
  }
}

/**
 * Run the whole acceptance check.
 */
async function main() {
  const { port } = parseArgs(process.argv.slice(2))
  console.log(`[selftest] host http://127.0.0.1:${port}`)

  const state = await callRoute(port, '/__tray-flash/state', 'GET')
  if (state.status !== 200) {
    console.error(`[selftest] state route answered ${state.status}: ${JSON.stringify(state.body)}`)
    console.error('[selftest] is the plugin installed, enabled, and is the Host restarted?')
    process.exit(2)
  }
  console.log(`[selftest] state: ${JSON.stringify(state.body.state)}`)

  const rect = await taskbarRect()
  if (rect.height < 8) {
    console.error(`[selftest] taskbar height ${rect.height}px — a hidden taskbar cannot be sampled`)
    process.exit(2)
  }
  console.log(`[selftest] sampling ${rect.width}x${rect.height} at (${rect.x},${rect.y})`)

  const directory = await mkdtemp(join(tmpdir(), 'tray-flash-'))
  try {
    // One baseline frame before the flash, so an idle taskbar's noise is known.
    const baseline = await captureFrames(rect, directory, 2, FRAME_DELAY_MS)

    const trigger = await callRoute(port, '/__tray-flash/self-test', 'POST')
    if (trigger.status !== 200) {
      console.error(`[selftest] self-test refused (${trigger.status}): ${JSON.stringify(trigger.body)}`)
      process.exit(2)
    }
    console.log(`[selftest] trigger: ${JSON.stringify({ hwnd: trigger.body.hwnd, started: trigger.body.started, reason: trigger.body.reason })}`)

    const flashFrames = await captureFrames(rect, directory, FRAME_COUNT, FRAME_DELAY_MS)
    await callRoute(port, '/__tray-flash/state', 'POST')

    const baselineDiff = await diffFrames([baseline[0], baseline[1]])
    const flashDiff = await diffFrames([baseline[0], ...flashFrames])

    const noise = Math.max(...baselineDiff.map((row) => row.changed))
    const peak = Math.max(...flashDiff.map((row) => row.changed))
    console.log(`[selftest] idle noise peak: ${noise}px`)
    console.log(`[selftest] flashed peak:   ${peak}px`)
    for (const row of flashDiff) console.log(`           ${row.file} changed=${row.changed} bbox=${JSON.stringify(row.bbox)}`)

    if (peak >= FLASH_PIXEL_THRESHOLD && peak > noise * 4) {
      console.log(`[selftest] PASS — taskbar flash observed (${peak}px ≫ ${noise}px noise)`)
      process.exitCode = 0
    } else {
      console.error(`[selftest] FAIL — no flash above ${FLASH_PIXEL_THRESHOLD}px (peak ${peak}px, noise ${noise}px)`)
      process.exitCode = 1
    }
  } finally {
    if (process.env.TRAY_FLASH_KEEP_FRAMES !== '1') await rm(directory, { recursive: true, force: true })
    else console.log(`[selftest] frames kept in ${directory}`)
  }
}

await main()
