// README screenshot of the 96x32 Matrix scoreboard, drawn the way the Beacon
// does it: a Team Tracker-style sensor, team logos fetched and shrunk by
// lib/logos.js, the scene compiled and rendered by public/scoreboard.js, then
// each LED painted as a dot (8x scale).
//   node scripts/readme-scoreboard.js [out.png]     (needs internet for the logos)
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const SB = require("../public/scoreboard.js");
const { createLogos } = require("../lib/logos");

const out = process.argv[2] || path.join(__dirname, "..", "docs", "screenshots", "matrix-scoreboard.png");
const LOGO = (team) => `https://a.espncdn.com/i/teamlogos/nfl/500/${team}.png`;
const entity = {
  entityId: "sensor.team_tracker", state: "IN",
  attributes: {
    sport: "football", league: "NFL", team_abbr: "KC", opponent_abbr: "DEN", team_homeaway: "away",
    team_score: "21", opponent_score: "24", quarter: 4, clock: "2:05 - 4th",
    team_logo: LOGO("kc"), opponent_logo: LOGO("den"), down_distance_text: "3rd & 4 DEN 38"
  }
};

function png(width, height, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const urls = [LOGO("kc"), LOGO("den")];
  const ready = new Set();
  const logos = createLogos({ onReady: (u) => ready.add(u) });
  for (const u of urls) logos.get(u);
  for (let i = 0; i < 100 && ready.size < urls.length; i++) await new Promise((r) => setTimeout(r, 100));
  if (ready.size < urls.length) throw new Error("logos didn't load (internet?)");

  const scene = SB.compile({ entityId: entity.entityId }, entity, (x) => x, "", logos.get);
  const S = 8, W = 96 * S, H = 32 * S, img = Buffer.alloc(W * H * 3, 0);
  for (let i = 0; i < img.length; i += 3) { img[i] = 5; img[i + 1] = 6; img[i + 2] = 5; }
  // The ticker scrolls; at 0 ms the whole down-and-distance is on the panel.
  SB.render(scene, 0, (x, y, c) => {
    const v = parseInt(c.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
    if (r + g + b < 40) return; // unlit
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
      const d = Math.hypot(dx - 3.5, dy - 3.5);
      if (d > 3.4) continue;
      const k = d > 2.6 ? 0.55 : 1; // soft edge
      const o = ((y * S + dy) * W + x * S + dx) * 3;
      img[o] = r * k; img[o + 1] = g * k; img[o + 2] = b * k;
    }
  });
  fs.writeFileSync(out, png(W, H, img));
  console.log(`wrote ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
