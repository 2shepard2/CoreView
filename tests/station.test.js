const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cleanView, defaultsFor, viewNeeds, catalog } = require('../lib/widgets');
const { stationFixture } = require('../scripts/dev-mock');

test('Station is in the palette, survives view validation and requests lab + sun', () => {
  assert.equal(catalog().widgets.station.minChrome, 44);
  const view = cleanView({ widgets: [{ id: 'rail', type: 'station', x: 0, y: 0, w: 100, h: 100, props: { ...defaultsFor('station'), title: 'Our station' } }] });
  assert.equal(view.widgets[0].props.title, 'Our station');
  assert.deepEqual(viewNeeds(view).data, ['lab']);
  assert.ok(viewNeeds(view).entities.includes('sun.sun'));
});

function draw(scene = 'healthy') {
  let factory, now = 0;
  const el = (tag, className, parent) => {
    assert.notEqual(tag, 'style', 'CSP forbids runtime style elements');
    const node = { tag, className, children: [], style: {}, textContent: '' };
    if (parent) parent.children.push(node);
    return node;
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/render-station.js'), 'utf8'), {
    CVRender: { util: { el, clear: (e) => { e.children = []; }, stateOf: (s, id) => s.states[id] }, register: (id, f) => { assert.equal(id, 'station'); factory = f; } }
  });
  const lab = stationFixture(scene);
  if (lab) lab.at = scene === 'stale' ? now - 180001 : now;
  const stage = { data: { lab }, states: {}, now: () => now, height: 720 };
  const box = el('div', '', null), widget = factory(box, stage, 'sample');
  widget.update(defaultsFor('station'));
  const nodes = (e = box) => [e, ...e.children.flatMap((n) => nodes(n))];
  return { stage, widget, nodes, advance: (ms) => { now += ms; widget.tick(); }, words: () => nodes().map((n) => n.textContent).join(' ') };
}

test('Station announces outages and warnings and gives warnings a longer visit', () => {
  const calm = draw(), hot = draw('host-hot'), down = draw('service-down');
  assert.match(calm.words(), /All lines running/);
  assert.match(hot.words(), /host 01 running hot/);
  assert.match(down.words(), /dns unavailable/);
  const train = (d) => d.nodes().find((n) => n.className.split(' ').includes('st-train'));
  assert.equal(train(calm).style.animationDuration, '5s');
  assert.equal(train(hot).style.animationDuration, '13s');
  assert.equal(train(hot).style.webkitAnimationDuration, '13s');
  assert.match(train(hot).className, /st-linger/);
  assert.equal(train(hot).style.animationDelay, '-0.000s');
  assert.equal(train(hot).style.webkitAnimationDelay, '-0.000s');
  // CSS holds for 2/5 or 10/13 of a leg, then moves for 3 seconds.
  const css = fs.readFileSync(require.resolve('../public/render.css'), 'utf8');
  for (const prefix of ['@keyframes', '@-webkit-keyframes']) {
    assert.ok(css.includes(`${prefix} st-visit { 0%,40% { left:0%; } 100% { left:100%; } }`));
    assert.ok(css.includes(`${prefix} st-linger { 0%,76.923077% { left:0%; } 100% { left:100%; } }`));
  }
  calm.advance(2500); hot.advance(2500);
  assert.equal(train(calm).style.animationDelay, '-0.000s', 'same leg keeps its DOM animation');
  assert.equal(train(hot).style.animationDuration, '13s');
  calm.widget.update(defaultsFor('station'));
  assert.equal(train(calm).style.animationDelay, '-2.500s', 'redraw resumes mid-travel');
  calm.advance(2500);
  const leg = calm.nodes().find((n) => n.className === 'st-leg');
  assert.equal(leg.style.left, '36%', 'next leg starts at the second host');
  assert.equal(train(calm).style.animationDelay, '-0.000s');
  hot.advance(10500);
  assert.equal(train(hot).style.animationDuration, '5s', 'next healthy stop has a short visit');
});

for (const scene of ['missing', 'failed', 'stale']) test(`${scene} lab is grey, honest and still`, () => {
  const d = draw(scene);
  assert.match(d.words(), /Can't hear the lab/);
  assert.doesNotMatch(d.words(), /All lines running/);
  assert.ok(d.nodes().filter((n) => n.className.split(' ').includes('st-train')).every((n) => !n.style.animationDuration));
});

test('A healthy map expires on tick without another feed event and recovers', () => {
  const d = draw();
  d.advance(180001);
  assert.match(d.words(), /Can't hear the lab/);
  d.stage.data.lab = stationFixture();
  d.stage.data.lab.at = 180001; d.widget.data();
  assert.match(d.words(), /All lines running/);
});

test('Partial answers never claim all is well; sun changes station lighting', () => {
  const d = draw('partial');
  assert.match(d.words(), /Some stops have no answer/);
  d.stage.states['sun.sun'] = { state: 'below_horizon' }; d.widget.states();
  assert.ok(d.nodes().some((n) => n.className.includes('st-night')));
});

for (const [scene, words] of [
  ['host-busy', 'host 01 busy'], ['host-down', 'host 01 offline'],
  ['storage-warn', 'tank nearly full'], ['storage-full', 'tank storage full'],
  ['storage-degraded', 'tank storage needs repair'], ['storage-down', 'tank offline'],
  ['gateway-hot', 'Gateway running hot'], ['gateway-full', 'Gateway nearly full'],
  ['gateway-down', 'Gateway offline'], ['internet-slow', 'Internet slow connection'],
  ['internet-missing', 'Some stops have no answer']
]) test(`Station story: ${scene}`, () => {
  assert.ok(draw(scene).words().includes(words));
});

test('Lab availability follows the feed contract, including optional flags and timestamps', () => {
  const d = draw();
  delete d.stage.data.lab.ok; delete d.stage.data.lab.at;
  d.widget.data();
  assert.match(d.words(), /All lines running/);
  d.stage.data.lab.ok = false; d.widget.data();
  assert.match(d.words(), /Can't hear the lab/);
  d.stage.data.lab.ok = true; d.stage.data.lab.stale = 'stale'; d.widget.data();
  assert.match(d.words(), /Can't hear the lab/);
  d.stage.data.lab.stale = false; d.stage.data.lab.at = 0; d.widget.data();
  d.advance(179999);
  assert.match(d.words(), /All lines running/);
  d.advance(1);
  assert.match(d.words(), /Can't hear the lab/);
});

test('Trains cover the route, return, loop, and stay still at unknown stops', () => {
  const d = draw();
  const train = () => d.nodes().find((n) => n.className.split(' ').includes('st-train'));
  d.advance(25000);
  assert.match(train().className, /st-return/);
  assert.equal(d.nodes().find((n) => n.className === 'st-leg').style.left, '36%');
  d.advance(15000);
  assert.doesNotMatch(train().className, /st-return/);
  assert.equal(d.nodes().find((n) => n.className === 'st-leg').style.left, '8%');
  const partial = draw('partial');
  assert.ok(partial.nodes().some((n) => n.className === 'st-train' && !n.style.animationDuration));
  const source = fs.readFileSync(require.resolve('../public/render-station.js'), 'utf8');
  assert.doesNotMatch(source, /style=/);
});

const serviceRows = (d) => d.nodes().filter((n) => n.className.split(' ').includes('st-route-services'));
const serviceStops = (d) => serviceRows(d).flatMap((r) => r.children.find((n) => n.className === 'st-track').children
  .filter((n) => n.className.split(' ').includes('st-stop')));
const stopWords = (n) => n.children.map((c) => c.textContent).join(' ');

test('Real-size services keep a non-core outage obvious and summarise only healthy probes', () => {
  const fixture = stationFixture('real-size');
  assert.equal(fixture.hosts.length, 4);
  assert.equal(fixture.stores.length, 3);
  assert.equal(fixture.services.length, 32);
  assert.equal(fixture.services.filter((s) => s.up === false).length, 1);
  assert.equal(fixture.services[31].core, false);
  const d = draw('real-size'), stops = serviceStops(d);
  assert.equal(stops.length, 4);
  assert.match(d.words(), /Weekend recipe collection 32 unavailable/);
  assert.match(stopWords(stops[0]), /Weekend recipe collection 32 unavailable/);
  assert.match(stops[0].className, /st-bad/);
  assert.match(stopWords(stops[1]), /Household automation 1/);
  assert.match(stopWords(stops[2]), /Family photo library 2/);
  assert.match(stopWords(stops[3]), /\+29 more all running/);
  const serviceTrain = d.nodes(serviceRows(d)[0]).find((n) => n.className.split(' ').includes('st-train'));
  assert.match(serviceTrain.className, /st-linger/);
  // Label slots are disjoint and contained in the track, including long names.
  let previousRight = 0;
  for (const n of stops) {
    const left = parseFloat(n.style.left) + parseFloat(n.style.marginLeft);
    const right = left + parseFloat(n.style.width);
    assert.ok(left >= previousRight && right <= 100);
    previousRight = right;
  }
});

test('Healthy real-size services are calm; a hidden probe losing its answer gets a named stop', () => {
  const d = draw('real-size-healthy');
  assert.match(d.words(), /All lines running/);
  assert.equal(serviceStops(d).length, 4);
  assert.match(d.words(), /\+29 more all running/);
  const last = d.stage.data.lab.services[31];
  last.up = null; d.widget.data();
  assert.match(d.words(), /Some stops have no answer/);
  assert.match(stopWords(serviceStops(d)[0]), /Weekend recipe collection 32 No answer/);
  assert.match(d.words(), /\+29 more all running/);
  assert.ok(d.nodes(serviceRows(d)[0]).filter((n) => n.className.split(' ').includes('st-train'))
    .every((n) => !n.style.animationDuration));
  last.up = false; d.widget.data();
  assert.match(d.words(), /Weekend recipe collection 32 unavailable/);
  last.up = true; d.widget.data();
  assert.match(d.words(), /All lines running/);
  assert.match(d.words(), /\+29 more all running/);
  assert.doesNotMatch(d.words(), /Weekend recipe collection 32/);
});

test('Healthy non-core or legacy probes are counted even without core metadata', () => {
  const d = draw('real-size-healthy');
  d.stage.data.lab.services.forEach((s) => { delete s.core; });
  d.widget.data();
  assert.equal(serviceStops(d).length, 1);
  assert.match(d.words(), /\+32 more all running/);
  d.stage.data.lab.services = d.stage.data.lab.services.slice(0, 4); d.widget.data();
  assert.equal(serviceStops(d).length, 4, 'small feeds retain every label');
  assert.doesNotMatch(d.words(), /more/);
});

test('Many service problems get continuation tracks, never a misleading healthy count', () => {
  const d = draw('real-size');
  d.stage.data.lab.services.forEach((s, i) => { s.up = i < 6 ? false : i < 9 ? null : true; });
  d.widget.data();
  assert.equal(serviceRows(d).length, 3);
  assert.equal(serviceStops(d).length, 10, 'nine problems and one healthy summary');
  for (const row of serviceRows(d)) {
    assert.ok(d.nodes(row).filter((n) => n.className.split(' ').includes('st-stop')).length <= 4);
  }
  for (const s of d.stage.data.lab.services.slice(0, 9)) {
    assert.ok(serviceStops(d).some((n) => stopWords(n).includes(s.label)), s.label + ' must be named');
  }
  assert.match(d.words(), /\+23 more all running/);
  d.stage.data.lab.services.forEach((s) => { s.up = false; }); d.widget.data();
  assert.equal(serviceRows(d).length, 8);
  assert.equal(serviceStops(d).length, 32);
  assert.doesNotMatch(d.words(), /all running/);
});
