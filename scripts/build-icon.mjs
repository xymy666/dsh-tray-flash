#!/usr/bin/env node
/**
 * Icon builder for the tray blink.
 *
 * The plugin's tray blink alternates the application's own icon with *nothing*,
 * like QQ's. That "nothing" has to be a real icon file: the shell has no way to
 * remove an image from a tray slot temporarily, only to replace it, so the blank
 * half of the blink is a fully transparent ICO.
 *
 * Which encoding the shell renders as empty space is not obvious, so it was
 * measured rather than assumed (see `scripts/probe-transparent.mjs`):
 *
 * | encoding                                   | result        |
 * |--------------------------------------------|---------------|
 * | alpha 0 + AND mask all ones                | **blank** ✅   |
 * | alpha 255 + AND mask all ones              | black square ❌ |
 * | 1 bpp                                      | blank (identical to the first) |
 *
 * The alpha channel is what the shell honours; a masked-out opaque image is not
 * the same thing. The AND mask is still all ones because some shells fall back to
 * it when alpha is unavailable.
 *
 * This module also exports the PNG and ICO codecs used by the probe scripts, so it
 * must stay importable without building anything: the build only runs when the
 * file is executed directly.
 *
 * @module dsh-tray-flash/build-icon
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Sizes Windows asks for at 100–200% scaling. */
export const SIZES = [16, 20, 24, 32, 40, 48]

/**
 * Build one fully transparent 32-bpp DIB icon frame.
 *
 * @param size - square size in pixels.
 * @returns the frame bytes, header included.
 */
export function transparentIcon(size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)          // BITMAPINFOHEADER
  header.writeInt32LE(size, 4)         // width
  header.writeInt32LE(size * 2, 8)     // height, doubled to include the AND mask
  header.writeUInt16LE(1, 12)          // planes
  header.writeUInt16LE(32, 14)         // bits per pixel
  header.writeUInt32LE(0, 16)          // BI_RGB
  header.writeUInt32LE(size * size * 4, 20)

  // Colour data, bottom-up BGRA. All zero: transparent black in every pixel.
  const pixels = Buffer.alloc(size * size * 4)

  // 1 bit per pixel, rows padded to 4 bytes; all ones marks every pixel
  // transparent for shells that use the mask instead of the alpha channel.
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size, 0xff)

  return Buffer.concat([header, pixels, mask])
}

/**
 * Render a preview that proves the frame is transparent.
 *
 * @param size - icon size, drawn at 4x.
 * @returns PNG bytes with a checkerboard behind the (absent) glyph.
 */
export function transparentPreview(size) {
  const zoom = 4
  const side = size * zoom
  const sheet = Buffer.alloc(side * side * 4)
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const offset = (y * side + x) * 4
      // Alternating grey, so "nothing here" is unmistakable in review.
      const tone = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0x2b : 0x3a
      sheet[offset] = tone
      sheet[offset + 1] = tone
      sheet[offset + 2] = tone + 4
      sheet[offset + 3] = 255
    }
  }
  return encodePng(sheet, side, side)
}

/**
 * CRC-32 of a buffer, as PNG chunks require.
 *
 * @param buffer - input bytes.
 * @returns the unsigned checksum.
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Encode RGBA pixels as PNG.
 *
 * @param pixels - RGBA bytes, row-major.
 * @param width - image width.
 * @param height - image height.
 * @returns PNG bytes.
 */
export function encodePng(pixels, width, height) {
  const stride = width * 4
  // Each scanline is prefixed with its filter type; filter 0 means "none".
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace

  /** Wrap one chunk with its length and CRC. */
  const chunk = (type, data) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([head, body, tail])
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Decode an 8-bit non-interlaced PNG to RGBA.
 *
 * @param bytes - PNG file bytes.
 * @returns the decoded image.
 */
export function decodePng(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG: bad signature')
  }

  let offset = 8
  let width
  let height
  let colorType
  const idat = []

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${String(data[8])}`)
      colorType = data[9]
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${String(colorType)}`)
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)

  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    unfilter(filter, line, previous, channels)
    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      out[to] = line[from]
      out[to + 1] = line[from + 1]
      out[to + 2] = line[from + 2]
      out[to + 3] = channels === 4 ? line[from + 3] : 255
    }
    line.copy(previous)
  }

  return { width, height, pixels: out }
}

/**
 * Reverse one PNG scanline filter in place.
 *
 * @param filter - filter type, 0–4.
 * @param line - the filtered bytes, replaced with the decoded ones.
 * @param previous - the previously decoded line.
 * @param channels - bytes per pixel.
 */
function unfilter(filter, line, previous, channels) {
  for (let index = 0; index < line.length; index += 1) {
    const left = index >= channels ? line[index - channels] : 0
    const up = previous[index]
    const upLeft = index >= channels ? previous[index - channels] : 0
    const value = line[index]
    if (filter === 1) line[index] = (value + left) & 0xff
    else if (filter === 2) line[index] = (value + up) & 0xff
    else if (filter === 3) line[index] = (value + ((left + up) >> 1)) & 0xff
    else if (filter === 4) {
      const estimate = left + up - upLeft
      const da = Math.abs(estimate - left)
      const db = Math.abs(estimate - up)
      const dc = Math.abs(estimate - upLeft)
      const predictor = da <= db && da <= dc ? left : (db <= dc ? up : upLeft)
      line[index] = (value + predictor) & 0xff
    }
  }
}

/**
 * Build an ICO container from frames.
 *
 * @param frames - `{ size, bytes }` entries.
 * @returns ICO file bytes.
 */
export function buildIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  let offset = 6 + frames.length * 16
  const entries = []
  for (const frame of frames) {
    const entry = Buffer.alloc(16)
    entry[0] = frame.size >= 256 ? 0 : frame.size
    entry[1] = frame.size >= 256 ? 0 : frame.size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(frame.bytes.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += frame.bytes.length
  }

  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.bytes)])
}

/**
 * Read an ICO container's frames.
 *
 * @param bytes - ICO file bytes.
 * @returns the frames with their declared widths and payloads.
 */
export function readIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(2) !== 1) throw new Error('not an ICO: bad header')
  const count = bytes.readUInt16LE(4)
  const frames = []
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16
    const width = bytes[at] === 0 ? 256 : bytes[at]
    const length = bytes.readUInt32LE(at + 8)
    const offset = bytes.readUInt32LE(at + 12)
    if (offset + length > bytes.length) throw new Error('ICO frame points past the end of the file')
    frames.push({ width, bytes: bytes.subarray(offset, offset + length) })
  }
  return frames
}

/**
 * Box-downsample RGBA pixels.
 *
 * @param pixels - source RGBA bytes.
 * @param from - source side length.
 * @param to - target side length.
 * @returns the resized pixels.
 */
export function resize(pixels, from, to) {
  if (from === to) return Buffer.from(pixels)
  const out = Buffer.alloc(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y += 1) {
    for (let x = 0; x < to; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      const yStart = Math.floor(y * ratio)
      const yEnd = Math.min(from, Math.ceil((y + 1) * ratio))
      const xStart = Math.floor(x * ratio)
      const xEnd = Math.min(from, Math.ceil((x + 1) * ratio))
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          const index = (sy * from + sx) * 4
          const alpha = pixels[index + 3]
          // Premultiply so fully transparent pixels do not drag the colour.
          r += pixels[index] * alpha
          g += pixels[index + 1] * alpha
          b += pixels[index + 2] * alpha
          a += alpha
          count += 1
        }
      }
      const to4 = (y * to + x) * 4
      if (a === 0) {
        out[to4] = 0
        out[to4 + 1] = 0
        out[to4 + 2] = 0
        out[to4 + 3] = 0
      } else {
        out[to4] = Math.round(r / a)
        out[to4 + 1] = Math.round(g / a)
        out[to4 + 2] = Math.round(b / a)
        out[to4 + 3] = Math.round(a / count)
      }
    }
  }
  return out
}

/**
 * Choose the largest usable frame from an ICO's PNG frames.
 *
 * @param frames - result of {@link readIco}.
 * @returns the widest frame.
 */
export function pickSourceFrame(frames) {
  return frames.reduce((best, frame) => (frame.width > best.width ? frame : best))
}

/**
 * Write `assets/blank.ico` and its preview.
 *
 * @param argv - process arguments after the script path; `--out <path>` overrides.
 */
export async function main(argv = []) {
  let output = join(root, 'assets', 'blank.ico')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      output = argv[index + 1]
      index += 1
    }
  }

  const frames = SIZES.map((size) => ({ size, bytes: transparentIcon(size) }))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, buildIco(frames), { mode: 0o644 })
  console.log(`[icon] wrote ${output} (${SIZES.join(', ')}, fully transparent)`)

  const previewPath = join(root, 'assets', 'blank-preview.png')
  await writeFile(previewPath, transparentPreview(SIZES.at(-1)), { mode: 0o644 })
  console.log(`[icon] wrote ${previewPath} (checkerboard shows through the empty icon)`)

  return output
}

// Run only when invoked directly: the probes import the codecs above, and
// rebuilding the icon as an import side effect would be a surprise.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  await main(process.argv.slice(2))
}
