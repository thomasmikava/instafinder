import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const kind = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  let c = 0xffffffff;
  for (const b of Buffer.concat([kind, data]))
    c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, kind, data, sum]);
}
function inside(x, y, vertices) {
  let value = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [a, b] = vertices[i],
      [c, d] = vertices[j];
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a)
      value = !value;
  }
  return value;
}
await mkdir("public/icons", { recursive: true });
for (const size of [32, 128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const colors = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const u = (x + (sx + 0.5) / 4) / size,
            v = (y + (sy + 0.5) / 4) / size;
          const dx = Math.max(Math.abs(u - 0.5) - 0.29, 0),
            dy = Math.max(Math.abs(v - 0.5) - 0.29, 0);
          let color =
            dx * dx + dy * dy < 0.16 ** 2 ? [25, 103, 84, 255] : [0, 0, 0, 0];
          const r = Math.hypot(u - 0.5, v - 0.5);
          if (r > 0.26 && r < 0.285) color = [226, 241, 228, 255];
          if (
            inside(u, v, [
              [0.64, 0.34],
              [0.47, 0.47],
              [0.53, 0.53],
            ])
          )
            color = [247, 250, 242, 255];
          if (
            inside(u, v, [
              [0.36, 0.66],
              [0.47, 0.47],
              [0.53, 0.53],
            ])
          )
            color = [133, 186, 161, 255];
          for (let c = 0; c < 4; c++) colors[c] += color[c];
        }
      const at = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 4; c++) pixels[at + c] = Math.round(colors[c] / 16);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `public/icons/${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
