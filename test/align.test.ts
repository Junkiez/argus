import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { align, mergeRegions } from '../src/align.ts';
import { decodePng, encodePng, type Image } from '../src/png.ts';

const W = 8;
/** Image built from rows: each entry is one row filled with that grey value. */
const img = (rows: number[]): Image => ({
  width: W, height: rows.length,
  data: Buffer.concat(rows.map((v) => Buffer.alloc(W * 4, v))),
});
const rowsOf = (i: Image) => Array.from({ length: i.height }, (_, y) => i.data[y * W * 4]);
const rep = (v: number, n: number) => Array<number>(n).fill(v);
const full = (top: number, bottom: number) => ({ top, bottom, left: 0, right: W });

describe('png', () => {
  it('round-trips RGBA pixels', () => {
    const src = { width: 3, height: 2, data: Buffer.from([1, 2, 3, 255, 4, 5, 6, 128, 7, 8, 9, 0, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255]) };
    assert.deepEqual(decodePng(encodePng(src)), src);
  });

  it('rejects non-PNG data', () => assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/));
});

describe('mergeRegions', () => {
  it('clamps, sorts, drops empty areas and merges touching ones', () => {
    const got = mergeRegions([
      { top: 50, bottom: 70, left: 2, right: 6 }, { top: -5, bottom: 10.2, left: 0, right: 99 },
      { top: 70, bottom: 80, left: 0, right: 3 }, { top: 20, bottom: 20, left: 0, right: 8 },
    ], 8, 100);
    assert.deepEqual(got, [{ top: 0, bottom: 11, left: 0, right: 8 }, { top: 50, bottom: 80, left: 0, right: 6 }]);
  });
});

describe('align', () => {
  it('same height: takes only the allowed box from local', () => {
    const base = img([1, 2, 3, 4]);
    const local = img([1, 9, 3, 4]);
    local.data[W * 4] = 7; // change left of the allowed box in the same row
    const out = align(base, local, [{ top: 1, bottom: 2, left: 4, right: 8 }])!;
    assert.equal(out.data[W * 4], 2, 'outside the box stays as in the reference');
    assert.equal(out.data[W * 4 + 4 * 4], 9, 'inside the box comes from local');
    assert.deepEqual(rowsOf(out).filter((_, y) => y !== 1), [1, 3, 4]);
  });

  it('allowed element grew: content below is matched at its new position', () => {
    const base = img([1, 2, 3, 4]);
    const local = img([1, 9, 9, 9, 3, 4]);
    assert.deepEqual(rowsOf(align(base, local, [full(1, 4)])!), rowsOf(local));
  });

  it('allowed element shrank or is new', () => {
    assert.deepEqual(rowsOf(align(img([1, 2, 2, 2, 3]), img([1, 9, 3]), [full(1, 2)])!), [1, 9, 3]);
    assert.deepEqual(rowsOf(align(img([1, 3]), img([1, 9, 9, 3]), [full(1, 3)])!), [1, 9, 9, 3]);
  });

  it('a change outside the allowed area survives alignment', () => {
    const out = align(img([1, 2, 3, 4]), img([1, 9, 9, 3, 5]), [full(1, 3)])!;
    assert.deepEqual(rowsOf(out), [1, 9, 9, 3, 4]); // last row still differs from local (5)
  });

  it('two allowed elements that both changed height', () => {
    const base = img([1, ...rep(2, 2), ...[30, 31, 32, 33], ...rep(4, 3), 50, 51]);
    const local = img([1, ...rep(8, 5), ...[30, 31, 32, 33], ...rep(9, 1), 50, 51]);
    const out = align(base, local, [full(1, 6), full(10, 11)])!;
    assert.deepEqual(rowsOf(out), rowsOf(local));
  });

  it('gives up when the allowed areas cannot explain the size change', () => {
    assert.equal(align(img([1, 2, 3]), img([1, 9, 3, 4, 5, 6]), [full(1, 2)]), null); // grew 3 rows, element is 1 tall
    assert.equal(align({ width: 4, height: 1, data: Buffer.alloc(16) }, img([1]), [full(0, 1)]), null); // width differs
    assert.equal(align(img([1, 2]), img([1, 2]), []), null);
  });
});
