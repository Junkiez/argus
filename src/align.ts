// "Nothing changed except X": rebuilds the reference image in the local
// image's geometry, with the allowed areas taken from local. Diffing local
// against the result then only shows changes outside the allowed areas, even
// when an allowed element grew or shrank and pushed the rest of the page.
import zlib from 'node:zlib';
import type { Image } from './png.ts';

/** Area of the local screenshot, in device pixels. */
export interface Region { top: number; bottom: number; left: number; right: number }

const MAX_SHIFT = 5000; // how far (px) content below an allowed area may have moved up
const SAMPLE = 2000;    // rows below an allowed area used to find how far it moved

/** Clamps to the image, drops empty areas, merges vertically touching ones. */
export function mergeRegions(rects: Region[], width: number, height: number): Region[] {
  const clamped = rects
    .map((r) => ({
      top: Math.max(0, Math.floor(r.top)), bottom: Math.min(height, Math.ceil(r.bottom)),
      left: Math.max(0, Math.floor(r.left)), right: Math.min(width, Math.ceil(r.right)),
    }))
    .filter((r) => r.bottom > r.top && r.right > r.left)
    .sort((a, b) => a.top - b.top);
  const out: Region[] = [];
  for (const r of clamped) {
    const last = out.at(-1);
    if (last && r.top <= last.bottom) {
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
    } else out.push(r);
  }
  return out;
}

const rowHashes = ({ width, height, data }: Image) =>
  Uint32Array.from({ length: height }, (_, y) => zlib.crc32(data.subarray(y * width * 4, (y + 1) * width * 4)));

/**
 * Returns the reference redrawn to match local outside the allowed areas, or
 * null when the allowed areas can't explain the size difference (different
 * width, or the page grew by more than the allowed elements are tall).
 */
export function align(base: Image, local: Image, rects: Region[]): Image | null {
  if (base.width !== local.width) return null;
  const W = local.width, HL = local.height, HB = base.height, stride = W * 4;
  const regions = mergeRegions(rects, W, HL);
  if (!regions.length) return null;
  const hL = rowHashes(local), hB = rowHashes(base);

  // shifts[k]: local row y below region k is base row y - shifts[k].
  const shifts: number[] = [];
  let prev = 0;
  for (const [k, g] of regions.entries()) {
    const h = g.bottom - g.top;
    const segEnd = regions[k + 1]?.top ?? HL;
    let s = HL - HB; // after the last region the page bottoms must line up
    if (k < regions.length - 1) {
      // Pick the shift under which the rows up to the next region match best;
      // on a tie, the one closest to "this area kept its height".
      const lo = Math.max(prev - MAX_SHIFT, segEnd - HB);
      const end = Math.min(segEnd, g.bottom + SAMPLE);
      let best = -1;
      for (let c = lo; c <= prev + h; c++) {
        let m = 0;
        for (let y = g.bottom; y < end; y++) if (hL[y] === hB[y - c]) m++;
        if (m > best || (m === best && Math.abs(c - prev) < Math.abs(s - prev))) { best = m; s = c; }
      }
      if (best < 0) return null;
    }
    // The area's height in the reference (h - growth) can't be negative.
    if (s - prev > h || segEnd - s > HB) return null;
    shifts.push(s);
    prev = s;
  }

  const out = Buffer.alloc(stride * HL);
  const rows = (src: Image, from: number, to: number, n: number) => src.data.copy(out, to * stride, from * stride, (from + n) * stride);
  let y = 0;
  prev = 0;
  for (const [k, g] of regions.entries()) {
    rows(base, y - prev, y, g.top - y);
    if (shifts[k] === prev) {
      // Same height: keep the reference beside the element, take only its box from local.
      rows(base, g.top - prev, g.top, g.bottom - g.top);
      for (let r = g.top; r < g.bottom; r++) local.data.copy(out, r * stride + g.left * 4, r * stride + g.left * 4, r * stride + g.right * 4);
    } else rows(local, g.top, g.top, g.bottom - g.top);
    y = g.bottom;
    prev = shifts[k];
  }
  rows(base, y - prev, y, HL - y);
  return { width: W, height: HL, data: out };
}
