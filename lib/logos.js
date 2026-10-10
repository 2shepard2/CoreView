// Team logos for the Matrix scoreboard: fetch the PNG Home Assistant's sports
// sensor links to, shrink it to an 18x18 and a 15x15 LED grid, and hand it to
// the scoreboard as base64 RGB (3 bytes per LED, black = off). Fetching is
// async; get() answers from the cache and calls onReady when a logo arrives.
const zlib = require("zlib");

const SIZES = [18, 15];
const RETRY_MS = 60 * 60 * 1000;

// Minimal PNG decoder: 8-bit greyscale/RGB/palette/grey+alpha/RGBA, not interlaced.
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString("latin1", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace || ![0, 2, 3, 4, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  if (width * height > 4096 * 4096) throw new Error("PNG too large");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, o = (y * width + x) * 4;
      if (type === 6) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = line[s + 3]; }
      else if (type === 2) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255; }
      else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = 255; }
      else if (type === 4) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = line[s + 1]; }
      else { const k = line[s]; out[o] = palette[k * 3]; out[o + 1] = palette[k * 3 + 1]; out[o + 2] = palette[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
    }
    [prev, line] = [line, prev];
  }
  return { width, height, rgba: out };
}

// Crop to the visible part, centre it in a square, area-average down to size,
// lift saturation a little (LEDs wash colour out) and keep 6-bit colour like the panel.
function shrink({ width, height, rgba }, size) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (rgba[(y * width + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const out = Buffer.alloc(size * size * 3);
  if (x1 < 0) return out;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, n = Math.max(w, h), ox = x0 - (n - w) / 2, oy = y0 - (n - h) / 2;
  for (let ty = 0; ty < size; ty++) for (let tx = 0; tx < size; tx++) {
    const sx0 = ox + tx * n / size, sx1 = ox + (tx + 1) * n / size, sy0 = oy + ty * n / size, sy1 = oy + (ty + 1) * n / size;
    let r = 0, g = 0, b = 0, a = 0, area = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      const wy = Math.min(y + 1, sy1) - Math.max(y, sy0), wx = Math.min(x + 1, sx1) - Math.max(x, sx0), k = wx * wy;
      area += k;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4, al = rgba[i + 3] / 255 * k;
      r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
    }
    const alpha = area ? a / area : 0;
    if (alpha < 70 / 255 || !a) continue;
    let pr = r / a, pg = g / a, pb = b / a;
    const grey = 0.299 * pr + 0.587 * pg + 0.114 * pb;
    pr = grey + (pr - grey) * 1.25; pg = grey + (pg - grey) * 1.25; pb = grey + (pb - grey) * 1.25;
    const q = (v) => (Math.max(0, Math.min(255, Math.round(v * alpha))) >> 2) << 2;
    const o = (ty * size + tx) * 3;
    out[o] = q(pr); out[o + 1] = q(pg); out[o + 2] = q(pb);
  }
  return out;
}

function encode(png) {
  const img = decodePng(png), sizes = {};
  for (const s of SIZES) sizes[s] = shrink(img, s).toString("base64");
  return sizes;
}

function createLogos({ fetch = globalThis.fetch, onReady = () => {}, log = () => {}, now = Date.now } = {}) {
  const cache = new Map(); // url -> { sizes } | { pending } | { failedAt }
  async function load(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) throw new Error("logo over 2 MB");
      cache.set(url, { sizes: encode(buf) });
      onReady(url);
    } catch (e) {
      log(`logos: ${url}: ${e.message}`);
      cache.set(url, { failedAt: now() });
    }
  }
  // Logo grids for a URL ({18: base64, 15: base64}), or null while loading/failed.
  function get(url) {
    if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) return null;
    const hit = cache.get(url);
    if (hit && hit.sizes) return hit.sizes;
    if (hit && (hit.pending || now() - hit.failedAt < RETRY_MS)) return null;
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(url, { pending: true });
    load(url);
    return null;
  }
  return { get };
}

module.exports = { createLogos, decodePng, shrink, encode, SIZES };
