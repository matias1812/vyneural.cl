// Gráfico de funciones para Play Console: 1024x500, ícono de ondas + el
// nombre "VYNEURAL" en una tipografía de píxeles dibujada a mano (sin
// dependencias — mismo encoder PNG puro que gen-icons.cjs).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'icons');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---- Fuente de píxeles 5x7 (clásica, mayúsculas) — solo las letras que
// necesitamos para "VYNEURAL" + "RITMOS BINAURALES". 1 = pixel encendido.
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(put, text, x0, y0, ps, color, alpha) {
  let x = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === '1') {
            for (let dy = 0; dy < ps; dy++) {
              for (let dx = 0; dx < ps; dx++) {
                put(x + col * ps + dx, y0 + row * ps + dy, color, alpha);
              }
            }
          }
        }
      }
    }
    x += 6 * ps; // 5 columnas + 1 de espaciado
  }
  return x - x0;
}
function textWidth(text, ps) {
  return text.length * 6 * ps - ps;
}

function render(width, height) {
  const S = 4;
  const W = width * S;
  const H = height * S;
  const bg = [11, 13, 26];
  const top = [167, 139, 250];
  const bot = [96, 165, 250];
  const white = [238, 240, 255];
  const dim = [154, 160, 195];
  const acc = new Float32Array(W * H * 4);

  const put = (x, y, col, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    acc[i] += col[0] * a;
    acc[i + 1] += col[1] * a;
    acc[i + 2] += col[2] * a;
    acc[i + 3] += a;
  };

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, bg, 1);

  // Halo sutil detrás del ícono (mitad izquierda).
  const iconCx = W * 0.2;
  const iconCy = H / 2;
  const R = H * 0.62;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W * 0.42; x++) {
      const d = Math.hypot(x - iconCx, y - iconCy) / R;
      if (d < 1) put(x, y, mix(top, bg, Math.min(1, d)), 0.16 * (1 - d));
    }
  }

  const bar = (cx, cy, h, w) => {
    const half = w / 2;
    const yTop = cy - h / 2;
    const yBot = cy + h / 2;
    for (let y = Math.floor(yTop - 1); y <= Math.ceil(yBot + 1); y++) {
      for (let x = Math.floor(cx - half - 1); x <= Math.ceil(cx + half + 1); x++) {
        let inside;
        if (y >= yTop + half && y <= yBot - half) {
          inside = Math.abs(x - cx) <= half;
        } else {
          const cyy = y < yTop + half ? yTop + half : yBot - half;
          const dx = x - cx;
          const dy = y - cyy;
          inside = dx * dx + dy * dy <= half * half;
        }
        if (inside) put(x, y, mix(top, bot, (y - cy) / h + 0.5), 1);
      }
    }
  };

  // Ícono de ondas, más chico, a la izquierda (deja espacio para el texto).
  const heights = [0.34, 0.58, 0.85, 0.58, 0.34];
  const barW = H * 0.075;
  const spacing = H * 0.16;
  heights.forEach((hf, i) => {
    const cx = iconCx + (i - (heights.length - 1) / 2) * spacing;
    bar(cx, iconCy, hf * H * 0.62, barW);
  });

  // Wordmark "VYNEURAL" + subtítulo, alineados a la derecha del ícono.
  // ps está en espacio SUPERSAMPLEADO (×S) — un glyph de 7 filas con
  // titlePs=40 da 280 sub-px = 70 px reales de alto, un tamaño de título
  // razonable para un banner de 500 px de alto.
  const titlePs = Math.round(height * 0.02) * S; // ~70px reales de alto (7 filas)
  const title = 'VYNEURAL';
  const titleW = textWidth(title, titlePs);
  const subPs = Math.round(height * 0.008) * S; // ~28px reales de alto
  const sub = 'RITMOS BINAURALES';
  const subW = textWidth(sub, subPs);
  const blockLeft = W * 0.46;
  const blockCenterX = blockLeft + Math.max(titleW, subW) / 2;
  // Math.round acá es crítico: acc es un Float32Array — escribir en un
  // índice no entero (typedArray[1884.16] = x) es un no-op SILENCIOSO en
  // JS, no un error. Con coordenadas fraccionarias, drawText no dibujaba
  // NADA sin importar la escala (bug real encontrado al depurar esto).
  const titleH = titlePs * 7;
  const subH = subPs * 7;
  const gap = titlePs * 0.9;
  const blockH = titleH + gap + subH;
  const titleX = Math.round(blockCenterX - titleW / 2);
  const subX = Math.round(blockCenterX - subW / 2);
  const titleY = Math.round(H / 2 - blockH / 2);
  const subY = Math.round(titleY + titleH + gap);
  drawText(put, title, titleX, titleY, titlePs, white, 1);
  drawText(put, sub, subX, subY, subPs, dim, 1);

  const out = Buffer.alloc(width * height * 4);
  const div = S * S;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          ar += acc[i]; ag += acc[i + 1]; ab += acc[i + 2]; aa += acc[i + 3];
        }
      }
      const o = (y * width + x) * 4;
      if (aa > 0) {
        out[o] = Math.round(ar / aa);
        out[o + 1] = Math.round(ag / aa);
        out[o + 2] = Math.round(ab / aa);
        out[o + 3] = 255;
      } else {
        out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255;
      }
    }
  }
  return encodePng(width, height, out);
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'feature-graphic-1024x500.png');
fs.writeFileSync(file, render(1024, 500));
console.log('ok', file, fs.statSync(file).size, 'bytes');
