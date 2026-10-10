// 16x16 home scenes for the bedroom matrix (WLED). One renderer for Studio's
// preview and the frames lib/minimatrix.js streams to the panel.
// render(scene, ms, put) calls put(x, y, "#rrggbb") for every lit LED.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreViewMini = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const N = 16;
  // 3x5 font, rows top to bottom, 3 bits each.
  const F = {
    A:'010101111101101',B:'110101110101110',C:'011100100100011',D:'110101101101110',E:'111100110100111',
    F:'111100110100100',G:'011100101101011',H:'101101111101101',I:'111010010010111',J:'001001001101010',
    K:'101101110101101',L:'100100100100111',M:'101111111101101',N:'110101101101101',O:'010101101101010',
    P:'110101110100100',Q:'010101101110011',R:'110101110101101',S:'011100010001110',T:'111010010010010',
    U:'101101101101111',V:'101101101101010',W:'101101111111101',X:'101101010101101',Y:'101101010010010',
    Z:'111001010100111','0':'111101101101111','1':'010110010010111','2':'110001010100111','3':'110001010001110',
    '4':'101101111001001','5':'111100110001110','6':'011100111101111','7':'111001010010010','8':'111101111101111',
    '9':'111101111001110',' ':'000000000000000','!':'010010010000010',':':'000010000010000','.':'000000000000010',
    '-':'000000111000000','?':'110001010000010','\'':'010010000000000','&':'010101010101011','/':'001001010100100'
  };
  // 5x7 letters (columns, MSB top) for inside the door frame.
  const BIG = { B:[127,73,73,73,54], F:[127,72,72,72,64], G:[62,65,73,73,46], S:[50,73,73,73,38], P:[127,72,72,72,48],
    L:[127,1,1,1,1], R:[127,72,76,74,49], K:[127,8,20,34,65], O:[62,65,65,65,62], D:[127,65,65,34,28] };
  const clean = (s, n) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9 !:.\-?'&/]/g, ' ').slice(0, n);
  const textW = s => Math.max(0, s.length * 4 - 1);

  const HOUSE = ['.......rr.......','......rrrr......','.....rrrrrr.....','....rrrrrrrr....','...rrrrrrrrrr...',
                 '..rrrrrrrrrrrr..','...wwwwwwwwww...','...wyywwwddww...','...wyywwwddww...','...wwwwwwddww...'];
  const DOOR = ['...bbbbbbbb.....','...b......b.....','...b......bo....','...b......boo...','...b......booo..',
                '...b......booo..','...b......booo..','...b......booo..','...b......booo..','...bbbbbbbbooo..'];
  const GARAGE = ['.......gg.......','.....gggggg.....','...gggggggggg...','.gggggggggggggg.','.g............g.',
                  '.g.oooooooooo.g.','.g............g.','.g.oooooooooo.g.','.g............g.','.g............g.'];
  const PERSON = ['.......pp.......','......pppp......','......pppp......','.......pp.......','.....pppppp.....',
                  '....pppppppp....','....p.pppp.p....','....p.pppp.p....','......p..p......','......p..p......'];
  const VIEWFINDER = ['vv............vv','v..............v','................','................','................',
                      '................','................','................','v..............v','vv............vv'];
  const DOG = ['................','..ee............','.eeee...........','eeweeeeeeeee....','keeeeeeeeeee....',
               '..eeeeeeeeee....','...eeeeeeeee....','...ee.....ee....','...ee.....ee....','...ee.....ee....'];
  const TAIL_UP = [[12,1],[12,2],[13,0]], TAIL_SIDE = [[12,3],[13,2],[14,2]];
  const WASHER = ['.gggggggggggggg.','.g.rr.y.......g.','.gggggggggggggg.','.g....bbbb....g.','.g..bb....bb..g.',
                  '.g..b......b..g.','.g..b......b..g.','.g..bb....bb..g.','.g....bbbb....g.','.gggggggggggggg.'];
  const BELL = ['.......yy.......','......yyyy......','.....yyyyyy.....','.....yyyyyy.....','.....yyyyyy.....',
                '....yyyyyyyy....','...yyyyyyyyyy...','...yyyyyyyyyy...','.......yy.......','................'];
  const ALERT = ['.......rr.......','......rrrr......','......rwwr......','.....rrwwrr.....','.....rrwwrr.....',
                 '....rrrwwrrr....','....rrrrrrrr....','...rrrrwwrrrr...','..rrrrrrrrrrrr..','................'];

  const hex = v => '#' + (0x1000000 + (v & 0xffffff)).toString(16).slice(1);
  const color = (c, d) => /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : d;
  function scale(c, k) {
    const v = parseInt(c.slice(1), 16);
    return hex(((((v >> 16) & 255) * k) << 16) | ((((v >> 8) & 255) * k) << 8) | ((v & 255) * k));
  }
  const pulse = (ms, period) => 0.55 + 0.45 * Math.sin(ms / period * Math.PI * 2);

  function render(scene, ms, put) {
    const set = (x, y, c) => { if (c && x >= 0 && x < N && y >= 0 && y < N) put(x, y, c); };
    const art = (rows, pal, dx = 0, dy = 0) => {
      for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
        const ch = rows[y][x];
        if (ch !== '.' && pal[ch]) set(x + dx, y + dy, pal[ch]);
      }
    };
    const text = (s, x, y, c) => {
      for (let i = 0; i < s.length; i++) {
        const g = F[s[i]] || F[' '];
        for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (g[r * 3 + k] === '1') set(x + i * 4 + k, y + r, c);
      }
    };
    const label = (s, c) => { const t = clean(s, 4); text(t, Math.floor((N - textW(t)) / 2), 11, c); };
    const scroll = (s, c, speed = 11) => {
      const t = clean(s, 120);
      if (!t) return;
      const span = textW(t) + N, off = Math.floor(ms * speed / 1000) % span;
      text(t, N - off, 11, c);
    };
    const big = (ch, x, y, c) => {
      const cols = BIG[ch];
      if (!cols) return text(clean(ch, 1), x + 1, y + 1, c);
      for (let k = 0; k < 5; k++) for (let r = 0; r < 7; r++) if (cols[k] & (1 << (6 - r))) set(x + k, y + r, c);
    };
    const s = scene || {};
    if (s.kind === 'arrival') {
      art(HOUSE, { r: '#c8321e', w: '#b9a789', y: '#ffcc55', d: scale('#ffb347', 0.3 + 0.7 * Math.min(1, ms / 800)) });
      label(s.label, color(s.color, '#ffffff'));
    } else if (s.kind === 'door') {
      art(DOOR, { b: '#8a6a45', o: scale('#ffad21', pulse(ms, 1600)) });
      big(clean(s.letter, 1) || 'D', 4, 2, '#ffffff');
      label('OPEN', '#ffad21');
    } else if (s.kind === 'garage') {
      art(GARAGE, { g: '#8c8c8c', o: scale('#ffad21', pulse(ms, 1600)) });
      label(s.label || 'GRGE', '#ffad21');
    } else if (s.kind === 'camera') {
      art(PERSON, { p: '#ff3b2f' });
      if (Math.floor(ms / 400) % 2 === 0) art(VIEWFINDER, { v: '#ffffff' });
      label(s.label || 'CAM', '#ff3b2f');
    } else if (s.kind === 'dogs') {
      art(DOG, { e: '#c08a4a', w: '#ffffff', k: '#3a2410' });
      for (const [x, y] of Math.floor(ms / 250) % 2 ? TAIL_UP : TAIL_SIDE) set(x, y, '#c08a4a');
      label('OUT', '#ffd27a');
    } else if (s.kind === 'laundry') {
      // Washer: blue water and bubbles, DONE. Dryer: warm drum with heat shimmer, DRY.
      const dryer = s.machine === 'dryer';
      art(WASHER, { g: '#9aa3ad', r: '#ff3b2f', y: '#63d44d', b: dryer ? '#ff9a3c' : '#4aa3ff' });
      const ph = Math.floor(ms / 300), fleck = dryer ? '#ffd27a' : '#bfe6ff';
      set(6 + (ph % 3), 6 - (ph % 2), fleck); set(9 - (ph % 2), 5 + (ph % 2), fleck);
      label(dryer ? 'DRY' : 'DONE', dryer ? '#ffad21' : '#63d44d');
    } else if (s.kind === 'notification') {
      const swing = ms % 4000 < 1200 ? (Math.floor(ms / 150) % 2 ? 1 : -1) : 0;
      art(BELL, { y: '#ffd400' }, swing, 0);
      scroll(s.text, '#ffffff');
    } else if (s.kind === 'alert') {
      art(ALERT, { r: Math.floor(ms / 350) % 2 === 0 ? '#ff2000' : '#5a0b00', w: '#ffffff' });
      scroll(s.text, '#ff5040');
    }
  }

  // Example scenes for tests and Studio's "try a scene" button.
  const SAMPLES = {
    arrival: { kind: 'arrival', label: 'DAD', color: '#3a8dff' },
    door: { kind: 'door', letter: 'B' },
    garage: { kind: 'garage', label: 'GRGE' },
    camera: { kind: 'camera', label: 'YARD' },
    dogs: { kind: 'dogs' },
    laundry: { kind: 'laundry', machine: 'washer' },
    dryer: { kind: 'laundry', machine: 'dryer' },
    notification: { kind: 'notification', text: 'Hello from Studio' },
    alert: { kind: 'alert', text: 'Test alert' }
  };
  const describe = s => !s ? "Nothing: WLED's own effect" :
    s.kind === 'arrival' ? `${s.label} came home` : s.kind === 'door' ? `Door open (${s.letter})` :
    s.kind === 'garage' ? 'Garage door up' : s.kind === 'camera' ? `Person on camera (${s.label})` :
    s.kind === 'dogs' ? 'Dogs need out' : s.kind === 'laundry' ? (s.machine === 'dryer' ? 'Dryer done' : 'Washer done') :
    s.kind === 'notification' ? `Notification: ${s.text}` : s.kind === 'alert' ? `Alert: ${s.text}` : s.kind;
  return { N, render, SAMPLES, describe, clean };
});
