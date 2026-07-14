"use strict";

// Generates logo.png with Node's standard library so the source artwork stays editable.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const width = 128;
const height = 128;
const pixels = Buffer.alloc((width * 4 + 1) * height);

for (let y = 0; y < height; y += 1) {
  const row = y * (width * 4 + 1);
  pixels[row] = 0;

  for (let x = 0; x < width; x += 1) {
    const offset = row + 1 + x * 4;
    const inside = isInsideRoundedRectangle(x, y, 0, 0, 128, 128, 29);
    let color = inside ? [23, 25, 29, 255] : [0, 0, 0, 0];

    const isLetter =
      (x >= 27 && x <= 45 && y >= 27 && y <= 101) ||
      (x >= 41 && x <= 72 && y >= 27 && y <= 42) ||
      (x >= 41 && x <= 72 && y >= 56 && y <= 71) ||
      (x >= 41 && x <= 72 && y >= 86 && y <= 101) ||
      (x >= 67 && x <= 86 && y >= 37 && y <= 61) ||
      (x >= 67 && x <= 88 && y >= 67 && y <= 91);

    if (isLetter) {
      const t = (x + y - 54) / 135;
      color = mix([124, 114, 255, 255], [76, 218, 154, 255], t);
    }

    if ((x - 103) ** 2 + (y - 26) ** 2 <= 8 ** 2) {
      color = [244, 211, 94, 255];
    }

    pixels.set(color, offset);
  }
}

const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", createHeader()),
  chunk("IDAT", zlib.deflateSync(pixels, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, "..", "logo.png"), png);

function createHeader() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return header;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isInsideRoundedRectangle(x, y, left, top, boxWidth, boxHeight, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + boxWidth - radius - 1));
  const nearestY = Math.max(top + radius, Math.min(y, top + boxHeight - radius - 1));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function mix(from, to, amount) {
  const t = Math.max(0, Math.min(1, amount));
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
}
