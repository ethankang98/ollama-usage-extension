// 아이콘 생성기: 외부 라이브러리 없이 PNG를 직접 인코딩합니다.
// node tools/make-icons.mjs  (프로젝트 루트에서 실행)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SS = 4; // 슈퍼샘플링 배율(안티에일리어싱)

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// 무압축(stored) deflate 블록만 사용해 zlib 스트림을 만듭니다.
function zlibStored(data) {
  const parts = [Buffer.from([0x78, 0x01])];
  const MAX = 65535;
  for (let i = 0; i < data.length; i += MAX) {
    const chunk = data.subarray(i, Math.min(i + MAX, data.length));
    const head = Buffer.alloc(5);
    head[0] = i + MAX >= data.length ? 1 : 0; // BFINAL
    head.writeUInt16LE(chunk.length, 1);
    head.writeUInt16LE(~chunk.length & 0xffff, 3);
    parts.push(head, chunk);
  }
  const ad = Buffer.alloc(4);
  ad.writeUInt32BE(adler32(data));
  parts.push(ad);
  return Buffer.concat(parts);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [15, 23, 42, 255]; // #0f172a
const RING = [34, 197, 94, 255]; // #22c55e
const RING_DIM = [71, 85, 105, 255]; // #475569
const DOT = [248, 250, 252, 255]; // #f8fafc

function render(size) {
  const W = size * SS;
  const rgba = Buffer.alloc(W * W * 4);
  const cx = W / 2;
  const cy = W / 2;
  const radius = W * 0.2; // 모서리 반경
  const ringR = W * 0.33;
  const ringT = W * 0.12;
  const inRounded = (x, y) => {
    const dx = Math.max(radius - x, 0, x - (W - radius));
    const dy = Math.max(radius - y, 0, y - (W - radius));
    return Math.hypot(dx, dy) <= radius;
  };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) continue;
      let c = BG;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d <= ringR + ringT / 2 && d >= ringR - ringT / 2) {
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 위쪽 기준
        if (deg < 0) deg += 360;
        c = deg <= 270 ? RING : RING_DIM;
      } else if (d <= ringT * 0.45) {
        c = DOT;
      }
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = c[3];
    }
  }
  // 다운샘플
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file);
}
