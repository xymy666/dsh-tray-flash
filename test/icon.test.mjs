/**
 * Smoke tests for the transparent-icon builder.
 *
 * The blank half of the tray blink has to be genuinely invisible, so the pieces
 * worth pinning are: the DIB header layout Windows expects, an all-zero colour
 * area (alpha included), an all-ones AND mask, and a PNG/ICO codec that carries
 * that through unchanged. A mistake in any of them shows up as a visible square
 * blinking in the tray.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildIco,
  crc32,
  decodePng,
  encodePng,
  pickSourceFrame,
  readIco,
  resize,
  transparentIcon,
} from '../scripts/build-icon.mjs'

/** Encode one solid-colour RGBA image as PNG. */
function solid(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) pixels.set(rgba, i * 4)
  return encodePng(pixels, width, height)
}

test('a PNG round-trips through the encoder and decoder', () => {
  const pixels = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < 16; i += 1) {
    pixels[i * 4] = i * 16
    pixels[i * 4 + 1] = 255 - i * 16
    pixels[i * 4 + 2] = 128
    pixels[i * 4 + 3] = 255
  }

  const decoded = decodePng(encodePng(pixels, 4, 4))

  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 4)
  assert.deepEqual(decoded.pixels, pixels)
})

test('alpha survives the round-trip', () => {
  const decoded = decodePng(solid(2, 2, [10, 20, 30, 0]))
  assert.equal(decoded.pixels[3], 0)
  assert.equal(decoded.pixels[7], 0)
})

test('crc32 matches the known check value', () => {
  // The canonical CRC-32 of "123456789".
  assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926)
})

test('a non-PNG source is rejected instead of half-decoded', () => {
  assert.throws(() => decodePng(Buffer.from('this is not a png at all')), /bad signature/)
})

test('box downsampling keeps the colour of a solid image', () => {
  const source = Buffer.alloc(8 * 8 * 4)
  for (let i = 0; i < 64; i += 1) source.set([200, 100, 50, 255], i * 4)

  const small = resize(source, 8, 4)

  assert.equal(small.length, 4 * 4 * 4)
  assert.deepEqual([...small.subarray(0, 4)], [200, 100, 50, 255])
})

test('resampling to the same size is a copy', () => {
  const source = Buffer.alloc(4 * 4 * 4, 7)
  const same = resize(source, 4, 4)

  assert.deepEqual(same, source)
  assert.notEqual(same, source, 'and not the same object')
})

test('a transparent frame declares the doubled height ICO requires', () => {
  const frame = transparentIcon(32)

  assert.equal(frame.readUInt32LE(0), 40, 'BITMAPINFOHEADER size')
  assert.equal(frame.readInt32LE(4), 32, 'width')
  assert.equal(frame.readInt32LE(8), 64, 'height covers the colour image and the mask')
  assert.equal(frame.readUInt16LE(14), 32, '32 bits per pixel so alpha is honoured')
  assert.equal(frame.length, 40 + 32 * 32 * 4 + 4 * 32)
})

test('a transparent frame has no colour and no alpha anywhere', () => {
  for (const size of [16, 24, 32, 48]) {
    const frame = transparentIcon(size)
    const pixels = frame.subarray(40, 40 + size * size * 4)
    const nonZero = [...pixels].filter((byte) => byte !== 0)
    assert.equal(nonZero.length, 0, `${size}px: every channel is zero, alpha included`)
  }
})

test('a transparent frame masks every pixel out as well', () => {
  // The alpha channel is what the shell honours, but the AND mask is the fallback
  // for shells that ignore it, so both have to say "nothing here".
  const size = 32
  const frame = transparentIcon(size)
  const mask = frame.subarray(40 + size * size * 4)
  assert.equal(mask.length, Math.ceil(size / 32) * 4 * size)
  for (const byte of mask) assert.equal(byte, 0xff)
})

test('the mask stride is padded to four bytes', () => {
  // A 16px row is 16 bits, which pads to 4 bytes; getting this wrong shifts every
  // following row and the shell renders garbage.
  for (const [size, expected] of [[16, 4], [24, 4], [32, 4], [48, 8]]) {
    const frame = transparentIcon(size)
    assert.equal(frame.length, 40 + size * size * 4 + expected * size, `${size}px mask stride`)
  }
})

test('the ICO directory points at its frames', () => {
  const frames = [16, 32].map((size) => ({ size, bytes: Buffer.alloc(64, size) }))
  const ico = buildIco(frames)

  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)

  const firstOffset = ico.readUInt32LE(6 + 12)
  const firstLength = ico.readUInt32LE(6 + 8)
  assert.equal(firstOffset, 6 + 2 * 16, 'frames start after the directory')
  assert.equal(firstLength, 64)
  assert.equal(ico[firstOffset], 16, 'and point at the frame bytes')

  const secondOffset = ico.readUInt32LE(6 + 16 + 12)
  assert.equal(secondOffset, firstOffset + 64, 'frames are contiguous')
})

test('a generated ICO is read back by its own parser', () => {
  const frames = [16, 24].map((size) => ({ size, bytes: Buffer.alloc(10, size) }))
  const parsed = readIco(buildIco(frames))

  assert.deepEqual(parsed.map((frame) => frame.width), [16, 24])
  assert.equal(parsed[1].bytes.length, 10)
})

test('a truncated ICO is refused, not silently trusted', () => {
  const ico = buildIco([{ size: 16, bytes: Buffer.alloc(64, 1) }])
  assert.throws(() => readIco(ico.subarray(0, ico.length - 10)), /past the end/)
})

test('not-an-ICO input is refused', () => {
  assert.throws(() => readIco(Buffer.alloc(32)), /not an ICO/)
})

test('the largest PNG frame is preferred as the source', () => {
  const png = Buffer.alloc(8)
  png.writeUInt32BE(0x89504e47, 0)
  const parsed = [
    { width: 16, height: 16, bytes: png },
    { width: 64, height: 64, bytes: png },
    { width: 32, height: 32, bytes: png },
  ]

  assert.equal(pickSourceFrame(parsed).width, 64)
})
