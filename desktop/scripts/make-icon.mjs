/**
 * Generate `build/icon.ico` — the MiniMarck mark, drawn from geometry, with no design tool.
 *
 * WHY GENERATE IT INSTEAD OF DROPPING A PNG IN. electron-builder fell back to the default
 * Electron icon and said so in the build log, which means every shop that installs this gets a
 * grey generic Electron diamond on their desktop, their Start Menu and their taskbar. For a till
 * that a person looks at all day, and for the Programs-and-Features row they will one day use to
 * uninstall it, that is a real "is this even the right program" moment.
 *
 * The icon is drawn here rather than imported so it is reproducible, reviewable and has no binary
 * blob of unknown provenance. The drawing is pure geometry — signed distance functions and a
 * smoothstep for anti-aliasing — so the same input always produces the same bytes.
 *
 * THE MARK. A shopping bag. Not a letterform: at 16x16 a letter is a grey smear, while a bag
 * silhouette with a handle is still recognisable, and "bag" is the one thing a point of sale is.
 * The handle is a half-ring above a rounded body, on a rounded-square background in the same
 * green the app uses for its primary actions.
 *
 * THE FILE FORMAT. An .ico is a small directory followed by the image data. Since Windows Vista an
 * entry may be a PNG rather than a BMP, which is far smaller and is what every modern tool
 * emits, so that is what this writes: seven sizes from 16 to 256, each a real PNG.
 */
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'build')
const outFile = path.join(outDir, 'icon.ico')

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

/** Encode RGBA bytes as a PNG. `rgba` is width*height*4. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with its filter type. 0 = None. The image is small and flat, so
  // real filtering would buy little and cost code; correctness is what matters here.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Geometry. All shapes are described in a normalised 0..1 square; the rasteriser scales.
// ---------------------------------------------------------------------------
/** Signed distance to a rounded rectangle centred at (cx, cy) with half-size h and corner radius r. */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** Signed distance to an annulus segment (a ring) clipped to the upper half. */
function sdHandle(px, py, cx, cy, rOuter, rInner) {
  const d = Math.hypot(px - cx, py - cy)
  const ring = Math.abs(d - (rOuter + rInner) / 2) - (rOuter - rInner) / 2
  // Clip to the top half: anything below the bag's top edge is part of the bag body anyway.
  const belowCentre = py - cy
  return Math.max(ring, belowCentre)
}

/** 0 outside, 1 inside, with a one-pixel smooth edge. */
function coverage(sd, px) {
  // `px` is the approximate width of one pixel at this scale, so the edge is one pixel wide
  // regardless of output size.
  return Math.min(1, Math.max(0, 0.5 - sd / px))
}

const lerp = (a, b, t) => a + (b - a) * t

/** Composite `src` over `dst` with coverage `a`. Both are [r,g,b,a] 0..1. */
function over(dst, src, a) {
  if (a <= 0) return dst
  const outA = a + dst[3] * (1 - a)
  if (outA <= 0) return [0, 0, 0, 0]
  return [
    (src[0] * a + dst[0] * dst[3] * (1 - a)) / outA,
    (src[1] * a + dst[1] * dst[3] * (1 - a)) / outA,
    (src[2] * a + dst[2] * dst[3] * (1 - a)) / outA,
    outA
  ]
}

// The palette. Deep green, the colour family the POS uses for primary actions.
const BG_TOP = [0.18, 0.49, 0.42]
const BG_BOTTOM = [0.09, 0.34, 0.29]
const MARK = [1, 1, 1]

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const onePx = 1 / size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample at pixel CENTRE, in normalised coordinates.
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size

      // Background: rounded square filling the canvas, with a vertical gradient.
      const bgSd = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.2)
      const bgA = coverage(bgSd, onePx)
      const t = v
      const bg = [lerp(BG_TOP[0], BG_BOTTOM[0], t), lerp(BG_TOP[1], BG_BOTTOM[1], t), lerp(BG_TOP[2], BG_BOTTOM[2], t), 1]

      let px = [0, 0, 0, 0]
      px = over(px, bg, bgA)

      if (bgA > 0) {
        // The bag: body plus handle, in white, clipped to the background.
        const bodySd = sdRoundRect(u, v, 0.5, 0.615, 0.255, 0.195, 0.045)
        const handleSd = sdHandle(u, v, 0.5, 0.44, 0.185, 0.115)
        const markA = Math.max(coverage(bodySd, onePx), coverage(handleSd, onePx)) * bgA
        px = over(px, [...MARK, 1], markA)
      }

      const i = (y * size + x) * 4
      rgba[i] = Math.round(Math.min(1, Math.max(0, px[0])) * 255)
      rgba[i + 1] = Math.round(Math.min(1, Math.max(0, px[1])) * 255)
      rgba[i + 2] = Math.round(Math.min(1, Math.max(0, px[2])) * 255)
      rgba[i + 3] = Math.round(Math.min(1, Math.max(0, px[3])) * 255)
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// ICO assembly
// ---------------------------------------------------------------------------
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const images = SIZES.map((size) => ({ size, png: encodePng(size, size, render(size)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type 1 = icon
header.writeUInt16LE(images.length, 4)

const dirEntries = []
let offset = 6 + images.length * 16
for (const { size, png } of images) {
  const e = Buffer.alloc(16)
  e[0] = size >= 256 ? 0 : size // 0 means 256, per the format
  e[1] = size >= 256 ? 0 : size
  e[2] = 0 // palette size; 0 for true colour
  e[3] = 0 // reserved
  e.writeUInt16LE(1, 4) // colour planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  dirEntries.push(e)
  offset += png.length
}

const ico = Buffer.concat([header, ...dirEntries, ...images.map((i) => i.png)])
mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, ico)

console.log(`ICON WRITTEN: ${path.relative(root, outFile)}  ${ico.length} bytes`)
console.log(`  sizes: ${SIZES.join(', ')}`)
for (const { size, png } of images) {
  console.log(`    ${String(size).padStart(3)}px -> ${String(png.length).padStart(6)} bytes PNG`)
}
