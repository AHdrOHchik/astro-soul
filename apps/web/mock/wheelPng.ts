/*
 * A stand-in picture for GET /charts/{id}/wheel.png: two rings, twelve spokes and two
 * marks, written out byte by byte so that the mock needs no image library. Not a real
 * chart: the real one is the SVG of packages/astro, turned into a PNG by apps/api.
 */
import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The widths the contract allows for `size`; the first one is the default. */
export const PNG_SIZES: readonly number[] = [1080, 1600];

/** Palette indexes: the picture needs three colours. */
const PAPER = 0;
const LINE = 1;
const MARK = 2;

const PALETTE = {
  dark: [0x1a, 0x17, 0x30, 0x6f, 0x67, 0xa0, 0xf1, 0xc7, 0x6a],
  light: [0xff, 0xff, 0xff, 0xac, 0xa6, 0xcb, 0xc9, 0x8a, 0x1b],
} as const;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** Where the Sun and the Moon of the mock wheel stand, in degrees clockwise from the top. */
const MARKS = [56, 183];

/** The colour of the pixel at (x, y), both measured from the centre in units of the half-width. */
function colourAt(x: number, y: number, lineWidth: number): number {
  const radius = Math.hypot(x, y);
  for (const angle of MARKS) {
    const radians = ((angle - 90) * Math.PI) / 180;
    if (Math.hypot(x - 0.75 * Math.cos(radians), y - 0.75 * Math.sin(radians)) < 0.03) return MARK;
  }
  if (Math.abs(radius - 0.95) < lineWidth || Math.abs(radius - 0.75) < lineWidth) return LINE;
  if (radius > 0.75 && radius < 0.95) {
    // Distance to the nearest of the twelve spokes, along the arc.
    const degrees = (Math.atan2(y, x) * 180) / Math.PI + 360;
    const offset = Math.abs(((degrees + 15) % 30) - 15);
    if (((offset * Math.PI) / 180) * radius < lineWidth) return LINE;
  }
  return PAPER;
}

const rendered = new Map<string, Buffer>();

/** Draws any width; which widths a request may ask for is the route's business (`PNG_SIZES`). */
export function renderMockWheelPng(theme: 'dark' | 'light', width: number): Buffer {
  const key = `${theme}:${String(width)}`;
  const ready = rendered.get(key);
  if (ready) return ready;

  // Every row: the filter byte (0, none), then one palette index per pixel.
  const rows = Buffer.alloc((width + 1) * width);
  const half = width / 2;
  const lineWidth = Math.max(1.5 / half, 0.004);
  for (let row = 0; row < width; row += 1) {
    for (let column = 0; column < width; column += 1) {
      rows[row * (width + 1) + 1 + column] = colourAt((column + 0.5 - half) / half, (row + 0.5 - half) / half, lineWidth);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header.set([8, 3, 0, 0, 0], 8); // 8 bits per pixel, indexed colour, no interlacing
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', Buffer.from(PALETTE[theme])),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  rendered.set(key, png);
  return png;
}
