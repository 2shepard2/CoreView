// Drawing boards: the whiteboard's two pages ("notes" for grown-ups, "play"
// for the grandkids) and the drawings put "on the fridge", which join photo
// slideshows. Kept by board name under <data>/boards/<name>/:
//   notes.png, play.png        the pages (no file = blank)
//   fridge/<ms>-<hex>.jpg      newest 30 kept
// Ported from an earlier standalone whiteboard app.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const NAME = /^[a-z0-9-]{1,32}$/;
const PAGES = ["notes", "play"];
const FRIDGE_ID = /^\d{13}-[0-9a-f]{6,8}$/;
const MAX_FRIDGE = 30;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// "data:image/png;base64,..." -> Buffer, or an error for anything else.
function fromDataUrl(s, kind) {
  const m = new RegExp(`^data:image/${kind};base64,([A-Za-z0-9+/=]+)$`).exec(String(s || ""));
  if (!m) throw bad(`Expected a ${kind} image`);
  return Buffer.from(m[1], "base64");
}

function createBoards(dataDir) {
  const root = path.join(dataDir, "boards");
  const dirOf = (name) => {
    if (!NAME.test(String(name))) throw bad("Unknown board");
    return path.join(root, name);
  };
  const pageFile = (name, page) => {
    if (!PAGES.includes(page)) throw bad("Unknown page");
    return path.join(dirOf(name), page + ".png");
  };
  function writeAtomic(file, buf) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return {
    PAGES,
    // A page as a Buffer, or null when blank.
    page(name, page) {
      const f = pageFile(name, page);
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    },
    savePage(name, page, dataUrl) {
      const f = pageFile(name, page);
      if (dataUrl === null) { fs.rmSync(f, { force: true }); return; }
      writeAtomic(f, fromDataUrl(dataUrl, "png"));
    },
    fridge(name) {
      const d = path.join(dirOf(name), "fridge");
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter((f) => /\.jpg$/.test(f)).map((f) => f.slice(0, -4)).filter((id) => FRIDGE_ID.test(id))
        .sort().reverse().map((id) => ({ id, at: Number(id.split("-")[0]) }));
    },
    addFridge(name, dataUrl) {
      const buf = fromDataUrl(dataUrl, "jpeg");
      const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      writeAtomic(path.join(dirOf(name), "fridge", id + ".jpg"), buf);
      for (const old of this.fridge(name).slice(MAX_FRIDGE)) fs.rmSync(path.join(dirOf(name), "fridge", old.id + ".jpg"), { force: true });
      return id;
    },
    fridgeImage(name, id) {
      if (!FRIDGE_ID.test(String(id))) return null;
      const f = path.join(dirOf(name), "fridge", id + ".jpg");
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    }
  };
}

module.exports = { createBoards, BOARD_NAME: NAME };
