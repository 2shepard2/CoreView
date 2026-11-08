// node scripts/smoke-station.mjs /tmp/cvs-station
// Needs Playwright + Chromium; PLAYWRIGHT may point at its module.
// Each scene boots a fresh local mock, saves/publishes a Station, pairs a
// display, checks its words and screenshots it. No real feed is contacted.
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const out = process.argv[2] || '/tmp/cvs-station';
mkdirSync(out, { recursive: true });
const DP = 3596, AP = 3597, studioUrl = `http://127.0.0.1:${AP}`, displayUrl = `http://127.0.0.1:${DP}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const scenes = [
  ['healthy', 'All lines running'],
  ['real-size', 'Weekend recipe collection 32 unavailable'],
  ['real-size-healthy', 'All lines running'],
  ['host-hot', 'host 01 running hot'],
  ['host-busy', 'host 01 busy'],
  ['host-down', 'host 01 offline'],
  ['service-down', 'dns unavailable'],
  ['storage-warn', 'tank nearly full'],
  ['storage-full', 'tank storage full'],
  ['storage-degraded', 'tank storage needs repair'],
  ['storage-down', 'tank offline'],
  ['gateway-hot', 'Gateway running hot'],
  ['gateway-full', 'Gateway nearly full'],
  ['gateway-down', 'Gateway offline'],
  ['internet-slow', 'Internet slow connection'],
  ['internet-missing', 'Some stops have no answer'],
  ['partial', 'Some stops have no answer'],
  ['missing', "Can't hear the lab"],
  ['stale', "Can't hear the lab"],
  ['failed', "Can't hear the lab"]
];
const browser = await chromium.launch();
const errors = [];
const watch = (page, scene) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${scene}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${scene}: ${e.message}`));
};
async function readableServices(page, scene) {
  const problem = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.st-stop-name, .st-stop-state, .st-line-name, .st-status, .st-title, .st-note'))
      .map((n) => ({ text: n.textContent, r: n.getBoundingClientRect() }))
      .filter((n) => n.text && n.r.width && n.r.height);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 1 &&
            Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > 1) {
          return `labels overlap: ${a.text} / ${b.text}`;
        }
      }
    }
    const map = document.querySelector('.st-map').getBoundingClientRect();
    for (const n of document.querySelectorAll('.st-route-services .st-stop-name, .st-route-services .st-stop-state')) {
      const r = n.getBoundingClientRect();
      if (r.left < map.left - 1 || r.right > map.right + 1 || r.top < map.top || r.bottom > map.bottom) return `clipped label: ${n.textContent}`;
      if (n.scrollWidth > n.clientWidth + 1) return `truncated label: ${n.textContent}`;
    }
    for (const row of document.querySelectorAll('.st-route-services')) {
      if (row.querySelectorAll('.st-stop').length > 4) return 'more than four service stops';
    }
    return '';
  });
  if (problem) throw new Error(`${scene}: ${problem}`);
  const healthy = scene === 'real-size-healthy';
  const summary = page.locator('.st-route-services .st-stop').filter({ hasText: '+29 more' });
  if (await summary.count() !== 1 || !(await summary.textContent()).includes('all running')) throw new Error(`${scene}: missing healthy summary`);
  if (!healthy) {
    const down = page.locator('.st-route-services .st-stop.st-bad');
    if (await down.count() !== 1 || !(await down.textContent()).includes('Weekend recipe collection 32')) throw new Error(`${scene}: down non-core service is not named`);
    const red = await down.evaluate((n) => getComputedStyle(n).color);
    if (red !== 'rgb(229, 57, 53)') throw new Error(`${scene}: down service is not red`);
  }
}
let shots = 0;
try {
  for (const [scene, words] of scenes) {
    const mock = spawn('node', [fileURLToPath(new URL('./dev-mock.js', import.meta.url))], {
      env: { ...process.env, DISPLAY_PORT: String(DP), ADMIN_PORT: String(AP), STATION_SCENE: scene,
        PROMETHEUS_URL: '', IMMICH_URL: '', FRIGATE_URL: '', DEMO_MEDIA: '', DEMO_HOST: '127.0.0.1', DATA_DIR: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let studioContext, displayContext;
    try {
      const haUrl = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${scene}: mock startup timeout`)), 30000);
        const fail = (e) => { clearTimeout(timeout); reject(e); };
        mock.once('error', fail);
        mock.once('exit', (code) => fail(new Error(`mock exited ${code}`)));
        mock.stdout.on('data', (b) => {
          const m = /calls (\S+)\/dev\/calls/.exec(String(b));
          if (m) { clearTimeout(timeout); resolve(m[1]); }
        });
      });
      studioContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const studio = await studioContext.newPage(); watch(studio, `${scene}/studio`);
      await studio.goto(studioUrl);
      await studio.fill('input[name=code]', 'dev-setup');
      await studio.fill('input[name=username]', 'admin');
      await studio.fill('input[name=password]', 'dev-password-1');
      await studio.click('button[type=submit]');
      await studio.waitForSelector('text=Screens');
      const api = (method, url, body) => studio.evaluate(async ([m, u, b]) => {
        const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: b ? JSON.stringify(b) : undefined });
        const j = r.status === 204 ? {} : await r.json();
        if (!r.ok) throw new Error(j.error || r.status);
        return j;
      }, [method, url, body]);
      const view = await api('POST', '/api/views', { name: 'The Station', aspect: { w: 1920, h: 1080 } });
      await api('PUT', `/api/views/${view.id}/draft`, { draft: { ...view.draft, widgets: [
        { id: 'rail', type: 'station', x: 0, y: 0, w: 100, h: 100, props: { title: 'The Station', sun: 'sun.sun', size: 2 } }
      ] } });
      // Publishing then checking the rendered title also proves save validation kept the widget.
      await api('POST', `/api/views/${view.id}/publish`);
      displayContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const display = await displayContext.newPage(); watch(display, `${scene}/display`);
      await display.goto(displayUrl);
      await display.waitForSelector('#pairCode:not(:empty)');
      const code = (await display.textContent('#pairCode')).trim();
      const paired = await api('POST', '/api/pair', { code, name: 'Station screen' });
      await api('PATCH', `/api/screens/${paired.screenId}`, { viewId: view.id });
      await display.waitForSelector('.st-root');
      await display.waitForFunction((w) => document.querySelector('.st-status')?.textContent === w, words);
      await display.screenshot({ path: `${out}/${scene}.png` }); shots++;
      if (scene.startsWith('real-size')) {
        await readableServices(display, scene);
        for (const [name, viewport] of [['small', { width: 1024, height: 600 }], ['portrait', { width: 600, height: 1024 }]]) {
          await display.setViewportSize(viewport); await pause(600);
          await readableServices(display, scene);
          await display.screenshot({ path: `${out}/${scene}-${name}.png` }); shots++;
        }
      }
      if (['missing', 'stale', 'failed'].includes(scene)) {
        const moving = await display.locator('.st-train').evaluateAll((nodes) => nodes.some((n) => getComputedStyle(n).animationName !== 'none'));
        if (moving) throw new Error(`${scene}: silent trains must be still`);
      }
      if (await display.locator('.st-root style').count()) throw new Error(`${scene}: runtime style element`);
      if (scene === 'healthy') {
        const trains = display.locator('.st-train');
        const names = await trains.evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).animationName));
        if (names.some((n) => !/^st-(visit|return)$/.test(n))) throw new Error('healthy: train keyframes are missing');
        // A healthy train must leave its stop, even when starting at a turnaround.
        const position = () => trains.first().evaluate((n) => n.getBoundingClientRect().left);
        const start = await position();
        let moved = false;
        for (let i = 0; i < 9; i++) {
          await pause(1000);
          if (Math.abs(await position() - start) > 2) { moved = true; break; }
        }
        if (!moved) throw new Error('healthy: train never moved');
        await studio.goto(`${studioUrl}/#/views/${view.id}`);
        await studio.waitForSelector('.st-root');
        await studio.screenshot({ path: `${out}/studio-editor.png` }); shots++;
        for (const [name, viewport] of [['small', { width: 1024, height: 600 }], ['portrait', { width: 600, height: 1024 }]]) {
          await display.setViewportSize(viewport); await pause(600);
          await display.screenshot({ path: `${out}/${name}.png` }); shots++;
        }
        await display.setViewportSize({ width: 1280, height: 720 });
        const r = await fetch(`${haUrl}/dev/state`, { method: 'POST', body: JSON.stringify({ 'sun.sun': { state: 'below_horizon' } }) });
        if (!r.ok) throw new Error('night state update failed');
        await display.waitForSelector('.st-night');
        await display.screenshot({ path: `${out}/night.png` }); shots++;
      }
      console.log('ok', scene);
    } finally {
      if (displayContext) await displayContext.close();
      if (studioContext) await studioContext.close();
      if (mock.exitCode === null) { const exited = once(mock, 'exit'); mock.kill(); await exited; }
    }
  }
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log(`Station smoke passed: ${shots} screenshots in ${out}`);
} finally { await browser.close(); }
