// Minimal PNG reader/writer for the screenshots Playwright produces
// (8-bit RGB or RGBA, not interlaced). Keeps the package dependency-free.
import zlib from 'node:zlib';

/** Decoded image, 4 bytes (RGBA) per pixel. */
export interface Image { width: number; height: number; data: Buffer }

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let width = 0, height = 0, ch = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace) {
        throw new Error(`unsupported PNG (bit depth ${depth}, color type ${color}${interlace ? ', interlaced' : ''}); expected 8-bit RGB/RGBA`);
      }
      ch = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ch) throw new Error('PNG has no IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const cur = y * stride;
    const up = cur - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[cur + x - ch] : 0;
      const b = y ? px[up + x] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const c = x >= ch && y ? px[up + x - ch] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[cur + x] = v;
    }
  }
  if (ch === 4) return { width, height, data: px };
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) px.copy(data, j, i, i + 3);
  return { width, height, data };
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body, zlib.crc32(head.subarray(4))), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng({ width, height, data }: Image): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (none) per row
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
