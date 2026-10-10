// Ported from CoreView V1 server/public/scoreboard.js (Studio change: home team on the right) (also loaded by Studio for the preview).
/* Shared scoreboard data contract and exact-pixel browser preview. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreViewScoreboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Five columns, seven rows, MSB at the top. Deliberately no antialiasing.
  const font = {
    ' ': [0,0,0,0,0], '0': [62,65,65,65,62], '1': [0,33,127,1,0],
    '2': [33,67,69,73,49], '3': [34,65,73,73,54], '4': [12,20,36,127,4],
    '5': [114,81,81,81,78], '6': [30,41,73,73,6], '7': [64,71,72,80,96],
    '8': [54,73,73,73,54], '9': [48,73,73,74,60],
    A: [63,68,68,68,63], B: [127,73,73,73,54], C: [62,65,65,65,34],
    D: [127,65,65,34,28], E: [127,73,73,73,65], F: [127,72,72,72,64],
    G: [62,65,73,73,46], H: [127,8,8,8,127], I: [0,65,127,65,0],
    J: [2,1,65,126,64], K: [127,8,20,34,65], L: [127,1,1,1,1],
    M: [127,32,24,32,127], N: [127,32,16,8,127], O: [62,65,65,65,62],
    P: [127,72,72,72,48], Q: [62,65,69,66,61], R: [127,72,76,74,49],
    S: [50,73,73,73,38], T: [64,64,127,64,64], U: [126,1,1,1,126],
    V: [124,2,1,2,124], W: [126,1,14,1,126], X: [99,20,8,20,99],
    Y: [96,16,15,16,96], Z: [67,69,73,81,97],
    ':': [0,0,36,0,0], '-': [8,8,8,8,8], '.': [0,1,1,0,0],
    '/': [3,4,8,16,96], '&': [54,73,85,34,5], '+': [8,8,62,8,8],
    "'": [0,96,0,0,0], '?': [32,64,69,72,48], '!': [0,0,125,0,0]
  };
  const palette = { background:'#050605', red:'#FF361F', amber:'#FFAD21', green:'#63D44D', divider:'#372914' };
  const clean = (value, limit) => String(value ?? '').toUpperCase().replace(/[^ A-Z0-9:./&+'?!-]/g, ' ').slice(0, limit);
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
  const speed = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(40, Number(value))) : 9;
  function score(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,3}$/.test(text) ? String(Number(text)) : '--';
  }
  function time(value) {
    const text = String(value ?? '').trim().toUpperCase();
    // Keep supplied leading zeroes; strip ESPN's trailing quarter description.
    const match = text.match(/^(\d{1,3}:\d{2})(?:\s|$)/);
    if (match) return match[1];
    if (/HALF/.test(text)) return 'HALF';
    if (/FINAL/.test(text)) return 'FINAL';
    return clean(text, 6);
  }
  function normalize(widget = {}) {
    const result = { kind:'scoreboard', label:String(widget.label || 'Scoreboard'), verticalAlign:'top',
      entityId:String(widget.entityId || '').trim().toLowerCase(), tickerSpeed:speed(widget.tickerSpeed ?? 9),
      leftIndicator:['auto','on','off'].includes(widget.leftIndicator) ? widget.leftIndicator : 'auto',
      rightIndicator:['auto','on','off'].includes(widget.rightIndicator) ? widget.rightIndicator : 'auto',
      leftColor:color(widget.leftColor, palette.green), rightColor:color(widget.rightColor, palette.amber),
      tickerEntries:(Array.isArray(widget.tickerEntries) ? widget.tickerEntries : []).slice(0,16).map(x => String(x).slice(0,256)) };
    for (const key of ['homeLabel','guestLabel','homeScore','guestScore','period','remainingTime']) result[key] = String(widget[key] ?? '').slice(0,256);
    return result;
  }
  // Score digits: 6x11 with two-pixel strokes; 5x11 for three-digit scores.
  const big = {
    '0':['.####.','##..##','##..##','##..##','##..##','##..##','##..##','##..##','##..##','##..##','.####.'],
    '1':['..##..','.###..','####..','..##..','..##..','..##..','..##..','..##..','..##..','..##..','######'],
    '2':['.####.','##..##','....##','....##','...##.','..##..','.##...','##....','##....','##....','######'],
    '3':['.####.','##..##','....##','....##','..###.','....##','....##','....##','....##','##..##','.####.'],
    '4':['...##.','..###.','.####.','##.##.','##.##.','##.##.','######','...##.','...##.','...##.','...##.'],
    '5':['######','##....','##....','##....','#####.','....##','....##','....##','....##','##..##','.####.'],
    '6':['.####.','##..##','##....','##....','#####.','##..##','##..##','##..##','##..##','##..##','.####.'],
    '7':['######','....##','....##','...##.','...##.','..##..','..##..','..##..','.##...','.##...','.##...'],
    '8':['.####.','##..##','##..##','##..##','.####.','##..##','##..##','##..##','##..##','##..##','.####.'],
    '9':['.####.','##..##','##..##','##..##','##..##','.#####','....##','....##','....##','##..##','.####.'],
    '-':['......','......','......','......','......','######','......','......','......','......','......']
  };
  const narrow = {
    '0':['.###.','##.##','##.##','##.##','##.##','##.##','##.##','##.##','##.##','##.##','.###.'],
    '1':['..##.','.###.','####.','..##.','..##.','..##.','..##.','..##.','..##.','..##.','#####'],
    '2':['.###.','##.##','...##','...##','..##.','..##.','.##..','.##..','##...','##...','#####'],
    '3':['.###.','##.##','...##','...##','..##.','...##','...##','...##','...##','##.##','.###.'],
    '4':['...##','..###','.####','##.##','##.##','#####','...##','...##','...##','...##','...##'],
    '5':['#####','##...','##...','##...','####.','...##','...##','...##','...##','##.##','.###.'],
    '6':['.###.','##.##','##...','##...','####.','##.##','##.##','##.##','##.##','##.##','.###.'],
    '7':['#####','...##','...##','..##.','..##.','..##.','.##..','.##..','.##..','.##..','.##..'],
    '8':['.###.','##.##','##.##','##.##','.###.','##.##','##.##','##.##','##.##','##.##','.###.'],
    '9':['.###.','##.##','##.##','##.##','##.##','.####','...##','...##','...##','##.##','.###.'],
    '-':['.....','.....','.....','.....','.....','#####','.....','.....','.....','.....','.....']
  };
  // A team colour bright enough to read as a 2x2 dot on black, or null.
  function teamColor(colors) {
    for (const c of Array.isArray(colors) ? colors : []) {
      if (!/^#[0-9a-f]{6}$/i.test(String(c))) continue;
      const v = parseInt(c.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
      if (Math.max(r, g, b) >= 128) return c;
    }
    return null;
  }
  // Studio: away team on the left, home team on the right. The wire fields keep V1's names, which the
  // Beacon draws by position: home* = LEFT slot, guest* = RIGHT slot. So the away team goes in home*.
  // logoFor(url) -> {18: base64, 15: base64} | null (lib/logos.js); leftLogo/rightLogo carry one size.
  function compile(widget, entity, render = x => x, externalTicker = '', logoFor = () => null) {
    const w = normalize(widget), a = entity?.attributes || {}, live = entity && !['unknown','unavailable','NOT_FOUND'].includes(entity.state);
    const away = a.team_homeaway === 'away';
    const home = away ? 'opponent' : 'team', guest = away ? 'team' : 'opponent';
    const left = guest, right = home;
    const state = entity?.state || '';
    const periodPrefix = a.sport === 'hockey' ? 'P' : a.sport === 'soccer' ? 'H' : ['baseball','softball'].includes(a.sport) ? 'I' : a.sport === 'volleyball' || a.sport === 'tennis' ? 'S' : a.sport === 'basketball' && /NCAAM/.test(a.league || '') ? 'H' : 'Q';
    const autoPeriod = !live && w.entityId ? 'WAIT' : state === 'POST' ? 'FINAL' : state === 'PRE' ? 'PRE' : /HALF/i.test(a.clock || '') ? 'HALF' : a.quarter ? periodPrefix + a.quarter : '';
    const pick = (key, fallback) => w[key] !== '' ? render(w[key]) : fallback;
    const indicator = (mode, team) => mode === 'on' || (mode === 'auto' && live && state === 'IN' && a.possession != null && a[team + '_id'] != null && String(a.possession) === String(a[team + '_id']));
    const entries = w.tickerEntries.map(render).filter(Boolean);
    if (!entries.length && live) entries.push([state === 'POST' ? 'FINAL' : a.event_name, a.down_distance_text || a.last_play || ''].filter(Boolean).join('  '));
    if (!live && w.entityId) entries.unshift('AWAITING GAME DATA');
    const start = Date.parse(a.date || '');
    const kickoff = Number.isFinite(start) ? new Date(start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }).replace(/\s/g, '') : '';
    const leftScore = score(pick('guestScore', live ? a[left + '_score'] : undefined)), rightScore = score(pick('homeScore', live ? a[right + '_score'] : undefined));
    const logoSize = leftScore.length > 2 || rightScore.length > 2 ? 15 : 18;
    const logo = url => { const l = live && logoFor(url); return (l && l[logoSize]) || ''; };
    return { kind:'scoreboard', homeLabel:clean(pick('guestLabel', a[left + '_abbr'] || 'GUEST'),5), guestLabel:clean(pick('homeLabel',a[right + '_abbr'] || 'HOME'),5),
      homeScore:leftScore, guestScore:rightScore,
      period:clean(pick('period',autoPeriod),5), remainingTime:pick('remainingTime',state === 'PRE' ? clean(kickoff,6) : time(state === 'POST' ? '' : live ? a.clock : '')),
      leftOn:indicator(w.leftIndicator,left), rightOn:indicator(w.rightIndicator,right),
      leftColor:teamColor(a[left + '_colors']) || w.leftColor, rightColor:teamColor(a[right + '_colors']) || w.rightColor,
      leftLogo:logo(a[left + '_logo']), rightLogo:logo(a[right + '_logo']),
      ticker:clean(externalTicker || entries.join('    '),512), tickerSpeed:w.tickerSpeed };
  }
  function decodeLogo(b64) {
    try {
      const bin = typeof atob === 'function' ? atob(String(b64 || '')) : Buffer.from(String(b64 || ''), 'base64').toString('binary');
      const size = Math.round(Math.sqrt(bin.length / 3));
      if (!size || size > 24 || size * size * 3 !== bin.length) return null;
      const px = [];
      for (let i = 0; i < bin.length; i += 3) px.push((bin.charCodeAt(i) << 16) | (bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i + 2));
      return { size, px };
    } catch (e) { return null; }
  }
  // Exact pixels the Beacon draws (firmware/beacon/components/coreview_scoreboard.h mirrors this).
  // Rows 0-22 game, 23 divider, 24-31 ticker. Logos at the edges, scores inside them, period on
  // top, clock in the middle.
  function render(scene, elapsedMs, pixel) {
    const put = (x,y,c,lo=0,hi=32) => { if(x>=0 && x<96 && y>=lo && y<hi) pixel(x,y,c); };
    const hex = v => '#' + (0x1000000 + v).toString(16).slice(1);
    for(let y=0;y<32;y++) for(let x=0;x<96;x++) put(x,y,palette.background);
    // 5x7 text with a two-pixel colon, so "12:34" is 25 px wide.
    const width = s => { let n=0; for(const ch of s) n += ch === ':' ? 2 : 6; return Math.max(0, n-1); };
    function text(value,x,y,c,lo=0,hi=32) {
      for(const ch of value) {
        if(ch === ':') { put(x,y+2,c,lo,hi); put(x,y+5,c,lo,hi); x+=2; continue; }
        const columns=font[ch] || font['?'];
        for(let col=0;col<5;col++) for(let row=0;row<7;row++) if(columns[col] & (1 << (6-row))) put(x+col,y+row,c,lo,hi);
        x+=6;
      }
    }
    const center = (s,cx,y,c) => text(s,cx-Math.floor(width(s)/2),y,c);
    const hs=score(scene.homeScore), gs=score(scene.guestScore);
    const wide = hs.length>2 || gs.length>2, size = wide ? 15 : 18, digits = wide ? narrow : big, gw = digits['0'][0].length;
    const scoreW = s => s.length*(gw+1)-1;
    const ly = Math.floor((23-size)/2);
    // Each side: logo at the edge and the score inside it. Without a logo the team's initials go on
    // top and the score is centred under them, in the same footprint, so nothing can collide.
    function side(b64, label, s, leftSide) {
      const logo = decodeLogo(b64), area = size+2+scoreW(s), a0 = leftSide ? 1 : 95-area;
      if (logo && logo.size === size) {
        const x0 = leftSide ? 1 : 95-size;
        for(let i=0;i<logo.px.length;i++) if(logo.px[i]) put(x0+i%size, ly+Math.floor(i/size), hex(logo.px[i]));
        return leftSide ? 1+size+2 : 95-size-2-scoreW(s);
      }
      const cx = a0+Math.floor(area/2);
      center(clean(label,4), cx, 0, palette.amber);
      return cx-Math.floor(scoreW(s)/2);
    }
    const lx = side(scene.leftLogo, scene.homeLabel, hs, true), rx = side(scene.rightLogo, scene.guestLabel, gs, false);
    const pre = scene.period === 'PRE';
    function number(s,x) {
      for(const ch of s) { const g = digits[ch] || digits['-'];
        for(let ry=0;ry<11;ry++) for(let rx=0;rx<gw;rx++) if(g[ry][rx] === '#') put(x+rx,8+ry,palette.red);
        x += gw+1; }
    }
    if(!pre) { number(hs,lx); number(gs,rx); }
    const dot = (cx,c) => { for(let d=0;d<4;d++) put(cx+d%2,20+(d>>1),c); };
    if(!pre && scene.leftOn) dot(lx+Math.floor(scoreW(hs)/2)-1, color(scene.leftColor,palette.green));
    if(!pre && scene.rightOn) dot(rx+Math.floor(scoreW(gs)/2)-1, color(scene.rightColor,palette.amber));
    center(clean(scene.period,5),48,0,palette.amber);
    center(clean(scene.remainingTime,6),48,11,palette.red);
    for(let x=0;x<96;x++) put(x,23,palette.divider);
    const ticker=clean(scene.ticker,512);
    if(ticker) {
      const span=Math.max(96,ticker.length*6-1)+48;
      const offset=Math.floor(Math.max(0,elapsedMs)*speed(scene.tickerSpeed)/1000)%span;
      textTicker(ticker,-offset); textTicker(ticker,span-offset);
    }
    function textTicker(t,x) {
      for(const ch of t) { const columns=font[ch] || font['?'];
        for(let col=0;col<5;col++) for(let row=0;row<7;row++) if(columns[col] & (1 << (6-row))) put(x+col,25+row,palette.amber,25,32);
        x+=6; }
    }
  }
  const sample = {kind:'scoreboard',homeLabel:'HOME',guestLabel:'GUEST',homeScore:'21',guestScore:'17',period:'Q4',remainingTime:'2:18',leftOn:true,rightOn:true,leftColor:palette.green,rightColor:palette.amber,ticker:'FINAL  NY 102  CHI 98',tickerSpeed:9};
  return { font,palette,clean,score,time,normalize,compile,render,sample,decodeLogo };
});
