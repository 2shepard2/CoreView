// Backup and restore of Studio's setup: screens, paired displays, views and
// the matrix settings. The admin password and sign-ins are never in a backup
// (a restore keeps the current ones), and drawings stay in data/boards.
//
// A restore goes through the same cleaners as the API, so a hand-edited or
// foreign file can't put anything into the store that the editor couldn't.
const FORMAT = 1;
const KIND = "coreview-studio-backup";

const VIEW_ID = /^view-[0-9a-f]{10}$/;
const SCREEN_ID = /^screen-[0-9a-f]{10}$/;
const DEVICE_ID = /^dev-[A-Za-z0-9_-]{12}$/;
const TARGET_ID = /^[a-z0-9-]{1,64}$/;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v, n, d = "") => (typeof v === "string" ? v.slice(0, n) : d);
const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : Date.now());
const bad = (message) => Object.assign(new Error(message), { status: 400 });

function exportBackup(data, { version, now = Date.now() } = {}) {
  // Waiting (unpaired) displays are short-lived; leave them out.
  const devices = {};
  for (const [id, d] of Object.entries(data.devices || {})) if (d.screenId) devices[id] = d;
  return {
    kind: KIND, format: FORMAT, studioVersion: version || null, exportedAt: new Date(now).toISOString(),
    data: {
      views: data.views || {}, screens: data.screens || {}, devices,
      matrix: data.matrix || { targets: {} }, minimatrix: data.minimatrix || { targets: {} },
      erased: data.erased || []
    }
  };
}

// c = { cleanView, cleanOverlay, cleanTimer, cleanNightDim, cleanMatrix, cleanMini }
function readBackup(input, c) {
  const b = obj(input);
  if (b.kind !== KIND) throw bad("That isn't a CoreView Studio backup file");
  if (b.format !== FORMAT) throw bad(`This backup is format ${b.format}; this Studio reads format ${FORMAT}`);
  const d = obj(b.data);

  const views = {};
  for (const [id, v] of Object.entries(obj(d.views))) {
    if (!VIEW_ID.test(id) || !v || typeof v !== "object") continue;
    const published = c.cleanView(v.published || v.draft);
    views[id] = { id, name: str(v.name, 60).trim() || "Restored view", draft: c.cleanView(v.draft || v.published), published,
      updatedAt: time(v.updatedAt), publishedAt: time(v.publishedAt) };
  }
  if (!Object.keys(views).length) throw bad("The backup has no views");
  const firstView = Object.keys(views)[0];

  const screens = {};
  for (const [id, s] of Object.entries(obj(d.screens))) {
    if (!SCREEN_ID.test(id) || !s || typeof s !== "object") continue;
    const out = { id, name: str(s.name, 60).trim() || "Restored screen", viewId: views[s.viewId] ? s.viewId : firstView,
      overlay: c.cleanOverlay(s.overlay, null) };
    if (s.timer) out.timer = c.cleanTimer(s.timer);
    if (s.nightDim) out.nightDim = c.cleanNightDim(s.nightDim);
    const p = obj(s.pin);
    if (HEX(32).test(p.salt) && HEX(64).test(p.hash) && [4, 5, 6].includes(p.length)) out.pin = { salt: p.salt, hash: p.hash, length: p.length };
    if (s.kids === true) out.kids = true;
    screens[id] = out;
  }

  // A display stays paired after a restore on the same install (its cookie
  // still matches keyHash); elsewhere it just shows a new code.
  const devices = {};
  for (const [id, x] of Object.entries(obj(d.devices))) {
    if (!DEVICE_ID.test(id) || !x || !screens[x.screenId] || !HEX(64).test(x.keyHash)) continue;
    const size = (n) => (Number.isInteger(n) && n > 0 && n < 20000 ? n : null);
    devices[id] = { id, keyHash: x.keyHash, code: str(x.code, 8), screenId: x.screenId, ua: str(x.ua, 300),
      chrome: Number.isInteger(x.chrome) ? x.chrome : null, label: str(x.label, 80, "Unknown device"),
      width: size(x.width), height: size(x.height), ip: str(x.ip, 64), createdAt: time(x.createdAt), lastSeen: time(x.lastSeen) };
  }

  const targets = (src, clean) => {
    const out = {};
    for (const [id, t] of Object.entries(obj(obj(src).targets))) {
      if (TARGET_ID.test(id) && t && typeof t === "object") out[id] = { ...clean(t, t), id };
    }
    return { targets: out };
  };

  const erased = (Array.isArray(d.erased) ? d.erased : []).filter((x) => x && typeof x.id === "string" && x.event && typeof x.event === "object")
    .slice(-200).map((x) => ({ id: str(x.id, 32), at: time(x.at), widget: str(x.widget, 64), calendar: str(x.calendar, 128),
      event: { title: str(x.event.title, 80), day: str(x.event.day, 10), time: typeof x.event.time === "string" ? x.event.time.slice(0, 5) : null } }));

  return { views, screens, devices, matrix: targets(d.matrix, c.cleanMatrix), minimatrix: targets(d.minimatrix, c.cleanMini), erased };
}

module.exports = { exportBackup, readBackup, KIND, FORMAT };
