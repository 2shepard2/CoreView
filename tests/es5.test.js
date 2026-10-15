// The display code must run on the master bedroom frame (Chrome 44): ES5
// syntax only, no newer DOM/JS APIs, and CSS without newer features.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const pub = (f) => path.join(__dirname, "..", "public", f);
const DISPLAY_JS = ["render.js", "render-household.js", "render-whiteboard.js", "render-lab.js", "render-media.js", "display.js"];
const DISPLAY_CSS = ["render.css", "display.css"];

for (const f of DISPLAY_JS) {
  test(`${f} parses as ES5`, () => {
    assert.doesNotThrow(() => acorn.parse(fs.readFileSync(pub(f), "utf8"), { ecmaVersion: 5, sourceType: "script" }));
  });

  test(`${f} avoids APIs newer than Chrome 44`, () => {
    const src = fs.readFileSync(pub(f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const banned = [
      ["Object.assign", /Object\.assign\b/], ["Array.from", /Array\.from\b/], ["fetch()", /\bfetch\s*\(/],
      ["Promise", /\bPromise\b/], ["replaceChildren", /replaceChildren/], ["append()", /\.append\(/], ["prepend()", /\.prepend\(/],
      [".remove() on elements", /\.remove\(\)/], ["closest()", /\.closest\(/], ["includes()", /\.includes\(/],
      ["startsWith()", /\.startsWith\(/], ["endsWith()", /\.endsWith\(/], ["padStart()", /\.padStart\(/], ["find()", /\.find\(/],
      ["findIndex()", /\.findIndex\(/], ["Number.isFinite", /Number\.isFinite/], ["Symbol", /\bSymbol\b/], ["Map/Set", /\bnew (Map|Set)\b/],
      ["URLSearchParams", /URLSearchParams/], ["IntersectionObserver", /IntersectionObserver/], ["requestIdleCallback", /requestIdleCallback/]
    ];
    for (const [name, re] of banned) assert.ok(!re.test(src), `${f} uses ${name}`);
  });
}

for (const f of DISPLAY_CSS) {
  test(`${f} avoids CSS newer than Chrome 44`, () => {
    const css = fs.readFileSync(pub(f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const banned = [
      ["inset", /(^|[;{\s])inset\s*:/], ["gap", /(^|[;{\s])(row-|column-)?gap\s*:/], ["clamp()", /clamp\(/], ["min()/max()", /[^-\w](min|max)\(/],
      ["custom properties", /var\(--|--[\w-]+\s*:/], ["#rgba hex", /#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{8}\b/], ["grid", /display\s*:\s*grid/],
      ["place-items", /place-(items|content)/], ["aspect-ratio", /aspect-ratio/], ["backdrop-filter", /backdrop-filter/],
      ["object-fit", /object-fit/], [":is/:where", /:(is|where)\(/]
    ];
    for (const [name, re] of banned) assert.ok(!re.test(css), `${f} uses ${name}`);
  });
}
