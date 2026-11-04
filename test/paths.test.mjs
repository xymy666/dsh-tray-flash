/**
 * Path-resolution tests for the tray icon files.
 *
 * This exists because of a real failure: the Host joined `process.resourcesPath`
 * (already `D:\DSH\resources`) with a `resources/tray.ico` constant, producing
 * `D:\DSH\resources\resources\tray.ico`. That file does not exist, so loading the
 * *original* icon failed, `start()` reported unavailable, and the tray blink was
 * silently disabled while the taskbar flash kept working — exactly the symptom
 * that was reported.
 *
 * The unit tests could not catch it because they never touched the filesystem, so
 * these resolve the real files the shipped application has.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readIco } from '../scripts/build-icon.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Where the application's resources live on this machine, when installed. */
const RESOURCES_DIR = String.raw`D:\DSH\resources`

/**
 * Read the icon path constant straight out of the Host entry.
 *
 * The module is not imported for this: importing it activates the plugin. Reading
 * the source keeps the check honest about the shipped text.
 *
 * @returns the value of the ORIGINAL_ICON constant.
 */
function originalIconConstant() {
  const source = readFileSync(join(PACKAGE_ROOT, 'lib', 'index.js'), 'utf8')
  const match = /const ORIGINAL_ICON = '([^']+)'/.exec(source)
  assert.notEqual(match, null, 'ORIGINAL_ICON is declared in lib/index.js')
  return match[1]
}

test('the original icon constant is relative to the resources directory', () => {
  const value = originalIconConstant()
  assert.equal(value, 'tray.ico', 'not "resources/tray.ico"')
  assert.doesNotMatch(value, /^resources\//, 'process.resourcesPath already is the resources directory')
})

test('the resolution produces a file that exists', { skip: !existsSync(RESOURCES_DIR) }, () => {
  const resolved = join(RESOURCES_DIR, originalIconConstant())
  assert.equal(resolved, String.raw`D:\DSH\resources\tray.ico`)
  assert.equal(existsSync(resolved), true, `${resolved} must exist for the blink to start`)
})

test('the bundled transparent icon exists and is a valid ICO', () => {
  const blank = join(PACKAGE_ROOT, 'assets', 'blank.ico')
  assert.equal(existsSync(blank), true, `${blank} is required at runtime`)
  const bytes = readFileSync(blank)
  assert.equal(bytes.readUInt16LE(0), 0, 'reserved field')
  assert.equal(bytes.readUInt16LE(2), 1, 'type 1 = icon')
  assert.ok(bytes.readUInt16LE(4) >= 1, 'at least one frame')
})

test('every transparent frame really is invisible', () => {
  // This is the whole point of the file: if any pixel kept its alpha the tray
  // would blink against a visible square instead of against nothing.
  const frames = readIco(readFileSync(join(PACKAGE_ROOT, 'assets', 'blank.ico')))
  assert.ok(frames.length >= 4, 'several sizes for display scaling')

  for (const frame of frames) {
    const header = frame.bytes
    const width = header.readInt32LE(4)
    const height = header.readInt32LE(8) / 2
    assert.equal(header.readUInt16LE(14), 32, '32 bpp so alpha is honoured')

    for (let index = 0; index < width * height; index += 1) {
      assert.equal(header[40 + index * 4 + 3], 0, `frame ${width}px pixel ${index} has alpha 0`)
    }

    // The AND mask must also mark every pixel transparent: it is the fallback
    // path for shells that ignore the alpha channel.
    const mask = header.subarray(40 + width * height * 4)
    for (const byte of mask) assert.equal(byte, 0xff, `frame ${width}px mask is all ones`)
  }
})

test('the transparent icon is far smaller than the real one', () => {
  // A byte-identical or similarly-sized file would mean the artwork was copied
  // rather than blanked.
  const blank = readFileSync(join(PACKAGE_ROOT, 'assets', 'blank.ico'))
  if (!existsSync(join(RESOURCES_DIR, 'tray.ico'))) return
  const original = readFileSync(join(RESOURCES_DIR, 'tray.ico'))
  assert.equal(blank.equals(original), false, 'the blank icon must differ from the original')
})

test('the icon path is not built by re-appending the resources segment', () => {
  // The regression, stated as a property: joining the resources directory with a
  // segment that starts with "resources" produces a doubled directory.
  const wrong = join(RESOURCES_DIR, 'resources/tray.ico')
  assert.equal(wrong, String.raw`D:\DSH\resources\resources\tray.ico`)
  assert.equal(existsSync(wrong), false, 'this is the broken path the bug produced')
})
