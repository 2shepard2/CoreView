const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createLab, firewallQueries } = require('../lib/lab');
const FW = { selector: 'job="firewall",instance="10.0.0.1:9100"', label: 'OPNsense', name: 'gateway', note: '10.0.0.1 · mini PC', alertPrefix: 'Opnsense' };
const Q = firewallQueries(FW.selector);
const { terrariumFixture } = require('../scripts/dev-mock');

const sample = (v) => [{ metric: {}, value: [Date.now() / 1000, String(v)] }];
function source(values = {}, fail = false, firewall = FW) {
  return createLab({ url: 'http://fixture', firewall, fetchImpl: async (url) => {
    const q = new URL(url).searchParams.get('query');
    if (fail && Object.values(Q).includes(q)) throw new Error('exporter unavailable');
    return { ok: true, json: async () => ({ data: q ? { result: values[q] || [] } : { alerts: [] } }) };
  } });
}
test('FreeBSD firewall queries: nulls remain unknown and zero swap is valid', async () => {
  const d = await source({ [Q.up]: sample(1), [Q.temp]: sample(78.2), [Q.disk]: sample(0.14), [Q.mem]: sample(0.36), [Q.swap]: sample(0), [Q.load]: sample(0.18), [Q.uptime]: sample(864000) }).refresh();
  assert.equal(d.ok, true);
  assert.deepEqual(d.firewall, { up: true, temp: 78.2, disk: 0.14, mem: 0.36, swap: 0, load: 0.18, uptime: 864000,
    label: 'OPNsense', name: 'gateway', note: '10.0.0.1 · mini PC', alertPrefix: 'Opnsense' });
  const absent = (await source({ [Q.up]: sample(1), [Q.swap]: sample('NaN') }).refresh()).firewall;
  assert.equal(absent.temp, null);
  assert.equal(absent.swap, null);
  assert.equal(absent.up, true);
  assert.match(Q.up, /last_over_time.*\[3m\]/);
  for (const q of Object.values(Q)) assert.match(q, /job="firewall",instance="10.0.0.1:9100"/);
  assert.deepEqual(firewallQueries('{' + FW.selector + '}'), Q);
});
test('firewall failure and missing exporter never break the existing lab', async () => {
  for (const src of [source({}, true), source({}), source({ [Q.up]: sample(0) })]) {
    const d = await src.refresh();
    assert.equal(d.ok, true);
    assert.equal(d.firewall.up, false);
    assert.deepEqual(d.hosts, []);
  }
});
test('no firewall selector: no firewall queries and no cloud', async () => {
  assert.equal(firewallQueries(''), null);
  const asked = [];
  const d = await createLab({ url: 'http://fixture', fetchImpl: async (url) => {
    const q = new URL(url).searchParams.get('query'); if (q) asked.push(q);
    return { ok: true, json: async () => ({ data: q ? { result: [] } : { alerts: [] } }) };
  } }).refresh();
  assert.equal(d.firewall, null);
  assert.ok(!asked.some((q) => /node_load1|node_memory_swap/.test(q)));
  const fx = terrariumFixture(); fx.firewall = null;
  assert.equal(render(fx).cloud(), undefined);
});

// Exercise the real ES5 renderer with a small DOM stand-in, including sheet clicks.
function render(d) {
  const nodes = [];
  function node(tag, cls = '', parent) {
    const n = { tag, className: cls, children: [], style: {}, textContent: '', innerHTML: '',
      appendChild(x) { this.children.push(x); }, setAttribute(k, v) { this[k] = v; } };
    if (parent) parent.appendChild(n);
    nodes.push(n); return n;
  }
  let factory, now = d.at;
  const stage = { data: { lab: d }, height: 492, now: () => now, tzOffsetMin: 0,
    openSheet(title) { stage.sheetTitle = title; return stage.sheet = node('div'); } };
  const CVRender = { util: { el: node, clear: (n) => { n.children = []; }, pad: String, DAYS: [], MONTHS: [] },
    localParts: () => ({ h: 12, mi: Math.floor(now / 60000) % 60, wd: 0, mo: 0, d: 1 }), register: (_, f) => { factory = f; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/render-lab.js'), 'utf8'), { CVRender, document: { createTextNode: (s) => ({ textContent: s }) } });
  const widget = factory(node('div'), stage, 'test'); widget.update({});
  return { nodes, stage, widget, advance: (ms) => { now += ms; widget.tick(); },
    cloud: () => nodes.filter((n) => /^tr-cloud /.test(n.className)).at(-1) };
}
for (const [state, level, detail] of [['healthy', 'ok', 'quiet'], ['warm', 'warn', '84°C'], ['hot', 'bad', '93°C'], ['disk-full', 'bad', '94%'], ['offline', 'bad', 'offline'], ['no-temp', 'ok', 'temperature unknown']]) {
  test(`cloud fixture ${state}: visual state, tooltip and sheet`, () => {
    const r = render(terrariumFixture(state)), cloud = r.cloud();
    assert.ok(cloud.className.includes('tr-cloud-' + level));
    assert.ok(cloud.title.includes(detail));
    assert.ok(cloud['aria-label'].includes('Firewall: gateway'));
    cloud.onclick({ stopPropagation() {} });
    assert.match(r.stage.sheetTitle, /OPNsense · gateway/);
    assert.ok(r.stage.sheet.children.some((n) => n.textContent.includes(detail)));
    assert.equal(r.nodes.filter((n) => n.className === 'tr-slot').length, 4);
    assert.equal(r.nodes.filter((n) => n.className.startsWith('tr-fly')).length, 4);
  });
}
test('cloud thresholds, memory, swap and stale data', () => {
  for (const [metric, value, level] of [['temp', 79.9, 'ok'], ['temp', 80, 'warn'], ['temp', 90, 'bad'], ['disk', 0.8, 'warn'], ['disk', 0.9, 'bad'], ['swap', 0.5, 'ok'], ['swap', 0.501, 'warn'], ['mem', 0.95, 'ok']]) {
    const d = terrariumFixture(); d.firewall[metric] = value;
    assert.ok(render(d).cloud().className.includes('tr-cloud-' + level), `${metric}=${value}`);
  }
  const r = render(terrariumFixture());
  r.advance(180000);
  assert.match(r.cloud().className, /tr-cloud-offline/);
  assert.ok(r.nodes.some((n) => n.className === 'tr-cloud-state' && n.textContent === 'offline'));
  const hot = render(terrariumFixture('hot'));
  const tag = hot.nodes.find((n) => n.className === 'tr-tag');
  assert.equal(tag.textContent, '⚠ 1 alert');
  tag.onclick({ stopPropagation() {} });
  assert.ok(hot.stage.sheet.children.some((n) => n.children.some((x) => /OPNsense/.test(x.textContent))));
});

test('extra stores come from the storage metric, not a fixed list', async () => {
  const row = (name, v) => ({ metric: { name }, value: [Date.now() / 1000, String(v)] });
  const d = await source({
    coreview_storage_up: [row('ssd-backup', 1), row('archive', 0)],
    coreview_storage_size_bytes: [row('ssd-backup', 1000)],
    coreview_storage_avail_bytes: [row('ssd-backup', 250)]
  }, false, {}).refresh();
  const extra = d.stores.slice(1);
  assert.deepEqual(extra.map((x) => [x.name, x.label, x.up]), [['ssd-backup', 'backup', true], ['archive', 'archive', false]]);
  assert.equal(extra[0].used, 0.75);
  assert.ok(!d.stores.some((x) => x.name === 'nas'), 'no store that the metric does not report');
});
