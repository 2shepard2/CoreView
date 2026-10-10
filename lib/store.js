// The whole Studio state lives in one JSON document (screens, devices, views,
// admin). It is small (tens of KB), so every change rewrites it atomically:
// write a temp file, fsync, rename. A copy of the previous version is kept
// as studio.json.prev so a bad write can be undone by hand.
const fs = require("node:fs");
const path = require("node:path");

const EMPTY = () => ({ version: 1, admin: null, screens: {}, devices: {}, views: {} });

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "studio.json");
  let data = EMPTY();
  if (fs.existsSync(file)) {
    data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  }

  function save() {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 1));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev`);
    fs.renameSync(tmp, file);
  }

  // All mutations go through here so nothing changes without being saved.
  function update(fn) {
    const result = fn(data);
    save();
    return result;
  }

  return { get data() { return data; }, update, file };
}

module.exports = { createStore };
