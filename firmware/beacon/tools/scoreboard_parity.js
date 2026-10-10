// Checks the Beacon's scoreboard renderer against Studio's (public/scoreboard.js)
// pixel for pixel. Usage: node tools/scoreboard_parity.js [dir of logo PNGs]
// Run from firmware/beacon; needs g++.
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const SB = require("../../../public/scoreboard.js");
const L = require("../../../lib/logos.js");
const bin = path.join(os.tmpdir(), "beacon-scoreboard-parity");
execFileSync("g++", ["-std=c++17", "-O2", "-Icomponents", "tools/scoreboard_parity.cpp", "-o", bin]);

// Logos: real PNGs if given, else coloured test patterns.
const logos = [];
const dir = process.argv[2];
if (dir) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".png"))) logos.push(L.encode(fs.readFileSync(path.join(dir, f))));
for (let k = 0; k < 4; k++) {
  const g = {};
  for (const n of [18, 15]) { const b = Buffer.alloc(n * n * 3); for (let i = 0; i < b.length; i++) b[i] = (i * (37 + k * 11)) & 0xfc; g[n] = b.toString("base64"); }
  logos.push(g);
}
const base = { homeLabel: "KC", guestLabel: "DEN", period: "Q3", remainingTime: "12:34", leftOn: false, rightOn: false,
  leftColor: "#e31837", rightColor: "#fc4c02", ticker: "2ND & 7 AT KC 34    LIVE ASU 21 UTAH 17", tickerSpeed: 9 };
const scores = [["14", "17"], ["7", "0"], ["99", "104"], ["100", "100"], ["--", "3"]];
const scenes = [];
logos.forEach((lg, i) => scores.forEach(([h, g], j) => {
  const size = h.length > 2 || g.length > 2 ? 15 : 18, other = logos[(i + 1) % logos.length];
  scenes.push({ ...base, homeScore: h, guestScore: g, leftOn: j % 2 === 0, rightOn: j % 3 === 0,
    leftLogo: j === 4 ? "" : lg[size], rightLogo: i % 3 === 2 ? "" : other[size], ms: String(i * 997 + j * 131) });
}));
scenes.push({ ...base, homeScore: "0", guestScore: "0", period: "PRE", remainingTime: "1:25PM", leftLogo: logos[0][18], rightLogo: "", ms: "0" });
scenes.push({ ...base, homeScore: "20", guestScore: "17", period: "FINAL", remainingTime: "", homeLabel: "MTST", guestLabel: "ASU", leftLogo: "", rightLogo: "", ms: "4000" });

let bad = 0;
for (const s of scenes) {
  const want = Buffer.alloc(96 * 32 * 3);
  SB.render(s, Number(s.ms), (x, y, c) => { const v = parseInt(c.slice(1), 16), o = (y * 96 + x) * 3; want[o] = v >> 16; want[o + 1] = (v >> 8) & 255; want[o + 2] = v & 255; });
  const input = Object.entries(s).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const got = execFileSync(bin, { input });
  if (!got.equals(want)) {
    bad++;
    let n = 0, first = -1;
    for (let i = 0; i < want.length; i += 3) if (got[i] !== want[i] || got[i + 1] !== want[i + 1] || got[i + 2] !== want[i + 2]) { n++; if (first < 0) first = i / 3; }
    console.log(`MISMATCH ${s.homeScore}-${s.guestScore} ${s.period}: ${n} px differ, first at x=${first % 96} y=${Math.floor(first / 96)}`);
  }
}
console.log(`${scenes.length - bad}/${scenes.length} scenes identical`);
process.exit(bad ? 1 : 0);
