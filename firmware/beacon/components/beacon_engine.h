// Beacon 2.0 renderer: one RGB frame buffer, drawn every frame and blitted to
// the HUB75 panel. Pure C++17 (no ESPHome headers) so tools/preview.cpp can
// render the exact same frames on a desktop.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "beacon_fonts.h"
#include "coreview_scoreboard.h"

namespace beacon {

// ---------------------------------------------------------------- colour ---

struct RGB {
  uint8_t r = 0, g = 0, b = 0;
};
static_assert(sizeof(RGB) == 3, "frame buffer is blitted as packed RGB888");
inline RGB rgb(int r, int g, int b) {
  return RGB{(uint8_t) std::max(0, std::min(255, r)), (uint8_t) std::max(0, std::min(255, g)),
             (uint8_t) std::max(0, std::min(255, b))};
}
inline RGB scale(RGB c, int v) {
  v = std::max(0, std::min(255, v));
  return RGB{(uint8_t) (c.r * v / 255), (uint8_t) (c.g * v / 255), (uint8_t) (c.b * v / 255)};
}
inline RGB add(RGB a, RGB b) { return rgb(a.r + b.r, a.g + b.g, a.b + b.b); }
inline RGB mix(RGB a, RGB b, int t) {  // t 0..255: 0 = a, 255 = b
  t = std::max(0, std::min(255, t));
  return RGB{(uint8_t) (a.r + (b.r - a.r) * t / 255), (uint8_t) (a.g + (b.g - a.g) * t / 255),
             (uint8_t) (a.b + (b.b - a.b) * t / 255)};
}
inline RGB hex(const std::string &s, RGB fallback) {
  unsigned int v = 0;
  if (s.size() == 7 && s[0] == '#' && sscanf(s.c_str() + 1, "%06x", &v) == 1) return RGB{(uint8_t) (v >> 16), (uint8_t) (v >> 8), (uint8_t) v};
  return fallback;
}
inline RGB from_u32(uint32_t v) { return RGB{(uint8_t) (v >> 16), (uint8_t) (v >> 8), (uint8_t) v}; }
// Smooth HSV, hue 0..255 wraps.
inline RGB hsv(int hue, int sat, int val) {
  hue &= 255;
  const int region = hue * 6 / 256, rem = (hue * 6) % 256;
  const int p = val * (255 - sat) / 255, q = val * (255 - sat * rem / 255) / 255, t = val * (255 - sat * (255 - rem) / 255) / 255;
  switch (region) {
    case 0: return rgb(val, t, p);
    case 1: return rgb(q, val, p);
    case 2: return rgb(p, val, t);
    case 3: return rgb(p, q, val);
    case 4: return rgb(t, p, val);
    default: return rgb(val, p, q);
  }
}

// Cyclic gradient palettes, sampled 0..255. "neon" is the full rainbow (the
// V1 look); the others are hand-picked stops.
struct Palette {
  int n;
  RGB stops[6];
};
inline const Palette &palette_named(const std::string &name) {
  static const Palette ocean{5, {{0, 10, 60}, {0, 70, 160}, {0, 170, 200}, {120, 230, 255}, {0, 120, 140}}};
  static const Palette sunset{5, {{60, 0, 90}, {200, 0, 120}, {255, 60, 30}, {255, 160, 0}, {150, 20, 80}}};
  static const Palette forest{5, {{0, 50, 10}, {20, 140, 20}, {140, 220, 30}, {0, 160, 110}, {60, 100, 0}}};
  static const Palette party{6, {{255, 0, 120}, {255, 200, 0}, {0, 230, 255}, {150, 0, 255}, {255, 90, 0}, {0, 255, 90}}};
  static const Palette neon{0, {}};
  if (name == "ocean") return ocean;
  if (name == "sunset") return sunset;
  if (name == "forest") return forest;
  if (name == "party") return party;
  return neon;
}
inline RGB pal(const Palette &p, int t) {
  t &= 255;
  if (p.n == 0) return hsv(t, 255, 255);
  const int pos = t * p.n, i = pos / 256, f = pos % 256;
  return mix(p.stops[i], p.stops[(i + 1) % p.n], f);
}
// Heat ramp black -> red -> orange -> yellow -> white for fire-like effects.
inline RGB heat_color(int h) {
  h = std::max(0, std::min(255, h));
  if (h < 85) return rgb(h * 3, 0, 0);
  if (h < 170) return rgb(255, (h - 85) * 3, 0);
  return rgb(255, 255, (h - 170) * 3);
}

// ------------------------------------------------------------------ math ---

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float ease(float t) {  // smoothstep-ish ease in/out
  t = clampf(t, 0.f, 1.f);
  return t * t * (3.f - 2.f * t);
}
// Fast sine on a 0..1 turn using a 256-entry table.
inline float sinturn(float turns) {
  static float table[257];
  static bool ready = false;
  if (!ready) {
    for (int i = 0; i <= 256; i++) table[i] = sinf(i * 6.2831853f / 256.f);
    ready = true;
  }
  float f = (turns - floorf(turns)) * 256.f;
  const int i = (int) f;
  f -= i;
  return table[i] + (table[i + 1] - table[i]) * f;
}
inline uint32_t hash32(uint32_t x) {
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
  return x;
}
inline float hash01(int x, int y, int z = 0) { return (hash32((uint32_t) x * 73856093U ^ (uint32_t) y * 19349663U ^ (uint32_t) z * 83492791U) & 0xFFFF) / 65535.f; }
// Smooth 2D value noise, 0..1.
inline float noise2(float x, float y) {
  const int xi = (int) floorf(x), yi = (int) floorf(y);
  const float fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const float a = hash01(xi, yi), b = hash01(xi + 1, yi), c = hash01(xi, yi + 1), d = hash01(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

struct Rng {
  uint32_t s = 0x12345678U;
  uint32_t next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
  float f() { return (next() & 0xFFFFFF) / 16777216.f; }        // 0..1
  float range(float a, float b) { return a + (b - a) * f(); }
  int below(int n) { return n <= 0 ? 0 : (int) (next() % (uint32_t) n); }
};

// ---------------------------------------------------------------- canvas ---

class Canvas {
 public:
  int w = 0, h = 0;
  std::vector<RGB> px;
  void resize(int width, int height) {
    w = width; h = height;
    px.assign((size_t) w * h, RGB{});
    clear_clip();
  }
  void clear_clip() { cx0 = 0; cy0 = 0; cx1 = w; cy1 = h; }
  void clip(int x, int y, int cw, int ch) {
    cx0 = std::max(0, x); cy0 = std::max(0, y); cx1 = std::min(w, x + cw); cy1 = std::min(h, y + ch);
  }
  bool inside(int x, int y) const { return x >= cx0 && x < cx1 && y >= cy0 && y < cy1; }
  RGB get(int x, int y) const { return (x >= 0 && x < w && y >= 0 && y < h) ? px[(size_t) y * w + x] : RGB{}; }
  RGB &at(int x, int y) { return px[(size_t) y * w + x]; }
  void set(int x, int y, RGB c) { if (inside(x, y)) px[(size_t) y * w + x] = c; }
  void add_px(int x, int y, RGB c) { if (inside(x, y)) { RGB &p = px[(size_t) y * w + x]; p = add(p, c); } }
  void blend(int x, int y, RGB c, int alpha) { if (inside(x, y)) { RGB &p = px[(size_t) y * w + x]; p = mix(p, c, alpha); } }
  void fill(RGB c) { std::fill(px.begin(), px.end(), c); }
  void fade(int keep) {  // multiply every pixel by keep/255
    for (auto &p : px) p = scale(p, keep);
  }
  // Anti-aliased point: spreads brightness over the four nearest pixels.
  void splat(float x, float y, RGB c) {
    const int xi = (int) floorf(x), yi = (int) floorf(y);
    const float fx = x - xi, fy = y - yi;
    add_px(xi, yi, scale(c, (int) ((1 - fx) * (1 - fy) * 255)));
    add_px(xi + 1, yi, scale(c, (int) (fx * (1 - fy) * 255)));
    add_px(xi, yi + 1, scale(c, (int) ((1 - fx) * fy * 255)));
    add_px(xi + 1, yi + 1, scale(c, (int) (fx * fy * 255)));
  }
  void hline(int x0, int x1, int y, RGB c) { if (x0 > x1) std::swap(x0, x1); for (int x = x0; x <= x1; x++) set(x, y, c); }
  void vline(int x, int y0, int y1, RGB c) { if (y0 > y1) std::swap(y0, y1); for (int y = y0; y <= y1; y++) set(x, y, c); }
  // ESPHome semantics: rect(x, y, width, height).
  void rect(int x, int y, int rw, int rh, RGB c) {
    if (rw <= 0 || rh <= 0) return;
    hline(x, x + rw - 1, y, c); hline(x, x + rw - 1, y + rh - 1, c);
    vline(x, y, y + rh - 1, c); vline(x + rw - 1, y, y + rh - 1, c);
  }
  void frect(int x, int y, int rw, int rh, RGB c) { for (int yy = y; yy < y + rh; yy++) for (int xx = x; xx < x + rw; xx++) set(xx, yy, c); }
  void line(int x0, int y0, int x1, int y1, RGB c) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      set(x0, y0, c);
      if (x0 == x1 && y0 == y1) break;
      const int e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  void circle(int cx, int cy, int r, RGB c) {
    int x = r, y = 0, err = 1 - r;
    while (x >= y) {
      set(cx + x, cy + y, c); set(cx + y, cy + x, c); set(cx - y, cy + x, c); set(cx - x, cy + y, c);
      set(cx - x, cy - y, c); set(cx - y, cy - x, c); set(cx + y, cy - x, c); set(cx + x, cy - y, c);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }
  void fcircle(int cx, int cy, int r, RGB c) {
    for (int y = -r; y <= r; y++) for (int x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) set(cx + x, cy + y, c);
  }
  void ftri(int x0, int y0, int x1, int y1, int x2, int y2, RGB c) {
    const int minx = std::min({x0, x1, x2}), maxx = std::max({x0, x1, x2}), miny = std::min({y0, y1, y2}), maxy = std::max({y0, y1, y2});
    auto edge = [](int ax, int ay, int bx, int by, int px_, int py_) { return (bx - ax) * (py_ - ay) - (by - ay) * (px_ - ax); };
    const int area = edge(x0, y0, x1, y1, x2, y2);
    if (area == 0) return;
    for (int y = miny; y <= maxy; y++) for (int x = minx; x <= maxx; x++) {
      const int a = edge(x1, y1, x2, y2, x, y), b = edge(x2, y2, x0, y0, x, y), d = edge(x0, y0, x1, y1, x, y);
      if ((a >= 0 && b >= 0 && d >= 0) || (a <= 0 && b <= 0 && d <= 0)) set(x, y, c);
    }
  }

 private:
  int cx0 = 0, cy0 = 0, cx1 = 0, cy1 = 0;
};

// ------------------------------------------------------------------ text ---

// Decodes UTF-8 into small-font glyph slots (0..94 = ASCII 32..126, 95 = °).
inline void glyph_slots(const std::string &s, std::vector<int> &out) {
  out.clear();
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = s[i];
    if (c < 0x80) {
      out.push_back(c >= 32 && c <= 126 ? c - 32 : '?' - 32);
      i++;
      continue;
    }
    uint32_t cp = 0;
    int len = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : 4;
    cp = c & (0x3F >> (len - 1));
    for (int k = 1; k < len && i + k < s.size(); k++) cp = (cp << 6) | (s[i + k] & 0x3F);
    i += len;
    if (cp == 0xB0) out.push_back(95);
    else if (cp == 0x2018 || cp == 0x2019) out.push_back('\'' - 32);
    else if (cp == 0x201C || cp == 0x201D) out.push_back('"' - 32);
    else if (cp == 0x2013 || cp == 0x2014) out.push_back('-' - 32);
    else if (cp == 0x2026) { out.push_back('.' - 32); out.push_back('.' - 32); out.push_back('.' - 32); }
    else out.push_back('?' - 32);
  }
}
inline int text_width(const std::string &s) {
  static std::vector<int> slots;
  glyph_slots(s, slots);
  int w = 0;
  for (int g : slots) w += beacon_fonts::small_index[g][1] + 1;
  return w > 0 ? w - 1 : 0;
}
// y is the top of the capital letters; descenders use two rows below.
inline int draw_text(Canvas &cv, int x, int y, const std::string &s, RGB c) {
  static std::vector<int> slots;
  glyph_slots(s, slots);
  for (int g : slots) {
    const int off = beacon_fonts::small_index[g][0], gw = beacon_fonts::small_index[g][1];
    if (x + gw >= 0 && x < cv.w)
      for (int col = 0; col < gw; col++) {
        const uint16_t bits = beacon_fonts::small_cols[off + col];
        for (int row = 0; row < beacon_fonts::small_height; row++) if (bits & (1U << row)) cv.set(x + col, y + row, c);
      }
    x += gw + 1;
  }
  return x;
}
inline int big_width(const std::string &s) {
  int w = 0;
  for (char ch : s) if (ch >= 32 && ch <= 58) w += beacon_fonts::big_index[ch - 32][1] + 2;
  return w > 0 ? w - 2 : 0;
}
// Lit pixels of one big glyph, relative to its top-left corner.
inline void big_pixels(char ch, std::vector<std::pair<int, int>> &out) {
  out.clear();
  if (ch < 32 || ch > 58) return;
  const int off = beacon_fonts::big_index[ch - 32][0], gw = beacon_fonts::big_index[ch - 32][1];
  for (int row = 0; row < beacon_fonts::big_height; row++)
    for (int col = 0; col < gw; col++) if (beacon_fonts::big_cols[off + col] & (1U << row)) out.push_back({col, row});
}

// ---------------------------------------------------------------- inputs ---

struct Inputs {
  uint32_t ms = 0;
  bool time_valid = false;
  int hour = 0, minute = 0, second = 0;
  int64_t epoch = 0;  // Unix seconds, when time_valid
  bool booting = false;
  uint32_t boot_elapsed = 0;
  bool claimed = true;
  std::string claim_code;
  std::string scene = "clock", title, detail, ticker, severity = "info", icon;
  bool flash_border = false;
  std::string effect = "scanner", palette = "neon";
  int speed = 35, intensity = 60;
  std::string music_mode = "spectrum", music_bands;
  int music_level = 0;
  bool music_active = false;
  // Local microphone analyser (optional): audio_bands bands of 0..255, bass
  // first; audio_beats counts beats.
  std::function<int(int)> audio_band;
  std::function<int()> audio_level;
  std::function<uint32_t()> audio_beats;
  int audio_bands = 16;
  bool audio_active = false;
  // Countdown scene: state running|paused|done, end (epoch s), seconds left when paused, total seconds.
  std::string count_state;
  int64_t count_ends = 0;
  int count_remaining = 0, count_duration = 0;
  std::string background = "#000000", primary = "#e6e8ed", secondary = "#0080ff", accent = "#ffb000", critical = "#ff2000";
};

struct Theme {
  RGB bg, primary, secondary, accent, critical;
};

// --------------------------------------------------------------- effects ---

struct FxCtx {
  uint32_t ms;
  float dt;      // seconds since last frame
  float ticks;   // speed-scaled time (V1 "frames"), monotonic
  float rate;    // ticks per second
  int level;     // 1..255 brightness from intensity
  int intensity; // 1..100
  const Palette *pal;
  bool neon;
  std::string word;
  Theme theme;
};

class Effect {
 public:
  virtual ~Effect() = default;
  virtual void reset(int w, int h, Rng &rng) { W = w; H = h; (void) rng; }
  virtual void render(Canvas &cv, const FxCtx &c, Rng &rng) = 0;

 protected:
  int W = 0, H = 0;
};

// Knight Rider scanner with a motion-blur trail, lighting the word as it passes.
class Scanner : public Effect {
  std::vector<float> trail;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); trail.assign(w, 0.f); }
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float period = 2.f * (W - 1);
    const float phase = fmodf(c.ticks, period) / period;               // 0..1 round trip
    const float x = (W - 1) * (0.5f - 0.5f * cosf(phase * 6.2831853f)); // eased ping-pong
    for (auto &t : trail) t *= expf(-c.dt * 5.f);
    const int xi = (int) roundf(x);
    for (int dx = -1; dx <= 1; dx++) if (xi + dx >= 0 && xi + dx < W) trail[xi + dx] = std::max(trail[xi + dx], dx == 0 ? 1.f : 0.55f);
    const RGB col = pal(*c.pal, (int) (c.ticks * 2));
    const RGB dim = scale(col, c.level * 60 / 255);
    cv.rect(0, 0, W, H, dim);
    const int tw = text_width(c.word), tx = W / 2 - tw / 2, ty = H / 2 - 4;
    Canvas &out = cv;
    // Word: dim everywhere, bright where the beam has been.
    static Canvas word;
    if (word.w != W || word.h != H) word.resize(W, H);
    word.fill(RGB{});
    draw_text(word, tx, ty, c.word, RGB{255, 255, 255});
    for (int yy = 0; yy < H; yy++) for (int xx = 0; xx < W; xx++) {
      if (word.at(xx, yy).r) out.set(xx, yy, scale(col, (int) (c.level * (0.45f + 0.55f * trail[xx]))));
    }
    for (int xx = 0; xx < W; xx++) {
      if (trail[xx] < 0.03f) continue;
      const RGB beam = scale(col, (int) (c.level * trail[xx]));
      for (int yy = 2; yy < H - 2; yy++) if (!word.at(xx, yy).r) out.add_px(xx, yy, scale(beam, (xx == xi) ? 255 : 150));
    }
  }
};

// The DVD-logo bounce: colour changes on each wall, sparkles on a corner hit.
class Bounce : public Effect {
  float x = 3, y = 3, vx = 14, vy = 7;
  int hue = 0;
  struct Spark { float x, y, vx, vy, life; RGB c; };
  std::vector<Spark> sparks;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); x = r.range(0, w / 2); y = r.range(0, h / 2); hue = r.below(256); sparks.clear(); }
  void render(Canvas &cv, const FxCtx &c, Rng &rng) override {
    const int tw = std::max(1, text_width(c.word)), th = 7;
    const float sp = 0.4f + c.rate / 25.f;
    x += vx * sp * c.dt; y += vy * sp * c.dt;
    bool hx = false, hy = false;
    if (x < 0) { x = 0; vx = fabsf(vx); hx = true; }
    if (x > W - tw) { x = (float) (W - tw); vx = -fabsf(vx); hx = true; }
    if (y < 0) { y = 0; vy = fabsf(vy); hy = true; }
    if (y > H - th) { y = (float) (H - th); vy = -fabsf(vy); hy = true; }
    if (hx || hy) hue += 47 + rng.below(40);
    if (hx && hy) for (int i = 0; i < 40; i++) {
      const float a = rng.range(0, 6.2831853f), s = rng.range(8, 40);
      sparks.push_back({x + tw / 2.f, y + th / 2.f, cosf(a) * s, sinf(a) * s, 1.f, pal(*c.pal, rng.below(256))});
    }
    for (auto &s : sparks) {
      s.x += s.vx * c.dt; s.y += s.vy * c.dt; s.vy += 30 * c.dt; s.life -= c.dt * 0.9f;
      if (s.life > 0) cv.splat(s.x, s.y, scale(s.c, (int) (s.life * c.level)));
    }
    sparks.erase(std::remove_if(sparks.begin(), sparks.end(), [](const Spark &s) { return s.life <= 0; }), sparks.end());
    const RGB col = c.neon ? hsv(hue, 255, c.level) : scale(pal(*c.pal, hue), c.level);
    draw_text(cv, (int) roundf(x), (int) roundf(y), c.word, col);
  }
};

class RainbowWaves : public Effect {
 public:
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float t = c.ticks;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const float wave = 0.72f + 0.28f * sinturn(x * 0.021f + y * 0.035f + t * 0.02f);
      cv.set(x, y, scale(pal(*c.pal, (int) (x * 2.6f + y * 5.f + t * 2.f)), (int) (c.level * wave)));
    }
  }
};

// Northern lights: noise-driven curtains that fade upward, faint stars behind.
class Aurora : public Effect {
 public:
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float t = c.ticks * 0.012f;
    for (int x = 0; x < W; x++) for (int y = 0; y < H; y += 1) {
      if (hash01(x, y, 7) > 0.985f) cv.set(x, y, scale(RGB{180, 200, 255}, (int) (c.level * 0.25f * (0.5f + 0.5f * sinturn(t * 3 + hash01(x, y, 9))))));
    }
    for (int band = 0; band < 3; band++) {
      const float bo = band * 17.3f;
      for (int x = 0; x < W; x++) {
        const float n = noise2(x * 0.06f + bo, t + bo);
        const float base = H * (0.45f + 0.45f * noise2(x * 0.035f + bo, t * 0.7f + 3));
        const float height = H * (0.3f + 0.5f * n);
        const float ray = noise2(x * 0.35f + bo, t * 2.5f);
        const float shimmer = 0.15f + 0.85f * ray * ray;
        const int hue = c.neon ? 85 + band * 40 + (int) (n * 50) : band * 70 + (int) (n * 90);
        const RGB col = c.neon ? hsv(hue, 230, 255) : pal(*c.pal, hue);
        for (int y = 0; y < H; y++) {
          const float d = (base - y) / height;  // 0 at the bottom edge, 1 at the top
          if (d < -0.15f || d > 1.f) continue;
          const float edge = d < 0 ? (1 + d / 0.15f) : (1 - d) * (1 - d);
          cv.add_px(x, y, scale(col, (int) (c.level * 0.8f * edge * shimmer)));
        }
      }
    }
  }
};

// Matrix rain: per-column drops with bright heads and flickering, decaying trails.
class DigitalRain : public Effect {
  struct Drop { float y, speed; int len; bool on; };
  std::vector<Drop> drops;
  std::vector<float> glow;
 public:
  void reset(int w, int h, Rng &r) override {
    Effect::reset(w, h, r);
    drops.resize(w);
    for (auto &d : drops) { d.y = r.range(-h, h); d.speed = r.range(0.5f, 1.6f); d.len = 6 + r.below(12); d.on = r.f() < 0.6f; }
    glow.assign((size_t) w * h, 0.f);
  }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    for (auto &g : glow) g *= expf(-c.dt * 1.4f);
    for (int x = 0; x < W; x++) {
      Drop &d = drops[x];
      if (!d.on) { if (r.f() < c.dt * 0.4f) { d.on = true; d.y = -r.range(0, 6); } continue; }
      const float prev = d.y;
      d.y += d.speed * c.rate * c.dt * 0.8f;
      for (int y = (int) prev; y <= (int) d.y; y++) if (y >= 0 && y < H) glow[(size_t) y * W + x] = 1.f;
      if (d.y - d.len > H) { d.on = r.f() < 0.7f; d.y = -r.range(0, 10); d.speed = r.range(0.5f, 1.6f); d.len = 6 + r.below(12); }
    }
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const float g = glow[(size_t) y * W + x];
      if (g < 0.02f) continue;
      const bool head = drops[x].on && (int) drops[x].y == y;
      const float flicker = hash01(x, y, (int) (c.ms / 90)) > 0.85f ? 0.55f : 1.f;
      const RGB base = c.neon ? RGB{40, 255, 70} : pal(*c.pal, 40 + (x * 7) % 90);
      cv.set(x, y, head ? scale(mix(base, RGB{230, 255, 230}, 200), c.level) : scale(base, (int) (c.level * g * g * flicker)));
    }
  }
};

// Classic heat-propagation fire.
class Fire : public Effect {
  std::vector<uint8_t> heat;
  float acc = 0;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); heat.assign((size_t) w * (h + 2), 0); }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    acc += c.dt * (20 + c.rate * 0.6f);
    const int rows = H + 2;
    while (acc >= 1) {
      acc -= 1;
      for (int x = 0; x < W; x++) {
        const float n = noise2(x * 0.15f, c.ms * 0.002f);
        heat[(size_t) (rows - 1) * W + x] = (uint8_t) clampf((0.45f + 0.55f * n) * (150 + c.intensity) + r.below(40), 0, 255);
      }
      for (int y = 0; y < rows - 1; y++) for (int x = 0; x < W; x++) {
        const int sx = std::max(0, std::min(W - 1, x + r.below(3) - 1));
        const int below = heat[(size_t) (y + 1) * W + sx];
        const int cool = r.below(4) + 250 / rows;
        heat[(size_t) y * W + x] = (uint8_t) std::max(0, below - cool);
      }
    }
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const int hv = heat[(size_t) y * W + x];
      const RGB col = c.neon ? heat_color(hv) : scale(pal(*c.pal, hv), std::min(255, hv * 2));
      cv.set(x, y, scale(col, c.level));
    }
  }
};

// Sparkles that bloom and fade smoothly.
class Twinkle : public Effect {
  std::vector<float> life;
  std::vector<uint8_t> hue;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); life.assign((size_t) w * h, 0.f); hue.assign((size_t) w * h, 0); }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    const float spawn = (W * H) * 0.012f * (c.rate / 15.f) * c.dt * 10.f;
    for (int i = 0; i < (int) spawn + (r.f() < spawn - (int) spawn ? 1 : 0); i++) {
      const size_t k = r.below(W * H);
      if (life[k] <= 0) { life[k] = 1.f; hue[k] = (uint8_t) r.below(256); }
    }
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const size_t k = (size_t) y * W + x;
      if (life[k] <= 0) continue;
      life[k] -= c.dt * (0.5f + c.rate / 60.f);
      const float l = std::max(0.f, life[k]);
      const float env = l > 0.8f ? (1 - l) / 0.2f : l / 0.8f;  // quick bloom, slow fade
      const RGB col = scale(mix(pal(*c.pal, hue[k]), RGB{255, 255, 255}, (int) (env * env * 120)), (int) (c.level * env));
      cv.add_px(x, y, col);
      if (env > 0.85f) { const RGB d = scale(col, 70); cv.add_px(x - 1, y, d); cv.add_px(x + 1, y, d); cv.add_px(x, y - 1, d); cv.add_px(x, y + 1, d); }
    }
  }
};

// Spiral arms rotating around the centre.
class Vortex : public Effect {
  std::vector<float> ang, rad;
 public:
  void reset(int w, int h, Rng &r) override {
    Effect::reset(w, h, r);
    ang.resize((size_t) w * h); rad.resize((size_t) w * h);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      const float dx = x - (w - 1) / 2.f, dy = (y - (h - 1) / 2.f) * 1.6f;
      ang[(size_t) y * w + x] = atan2f(dy, dx) / 6.2831853f;
      rad[(size_t) y * w + x] = sqrtf(dx * dx + dy * dy);
    }
  }
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float t = c.ticks * 0.01f;
    for (size_t k = 0; k < ang.size(); k++) {
      const float a = ang[k], rr = rad[k];
      const float arm = 0.5f + 0.5f * sinturn(a * 3 + rr * 0.035f - t);
      const int hue = (int) (a * 256 + rr * 3 - t * 160);
      cv.px[k] = scale(pal(*c.pal, hue), (int) (c.level * (0.25f + 0.75f * arm * arm)));
    }
  }
};

// Paper confetti tumbling down with flutter.
class Confetti : public Effect {
  struct Piece { float x, y, vy, phase, spin; RGB c; };
  std::vector<Piece> pieces;
 public:
  void reset(int w, int h, Rng &r) override {
    Effect::reset(w, h, r);
    pieces.resize(std::max(30, w * h / 28));
    for (auto &p : pieces) spawn(p, r, true);
  }
  void spawn(Piece &p, Rng &r, bool anywhere) {
    p.x = r.range(0, W); p.y = anywhere ? r.range(-H, H) : r.range(-6, -1); p.vy = r.range(4, 10);
    p.phase = r.range(0, 1); p.spin = r.range(0.6f, 1.8f); p.c = RGB{};
  }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    const float sp = 0.5f + c.rate / 30.f;
    for (auto &p : pieces) {
      if (p.c.r == 0 && p.c.g == 0 && p.c.b == 0) p.c = pal(*c.pal, r.below(256));
      p.y += p.vy * sp * c.dt;
      p.phase += p.spin * c.dt;
      const float sway = sinturn(p.phase) * 2.2f;
      if (p.y > H + 2) { spawn(p, r, false); continue; }
      const float face = fabsf(sinturn(p.phase * 2));  // tumbling: bright face vs edge-on
      const RGB col = scale(p.c, (int) (c.level * (0.35f + 0.65f * face)));
      const int px = (int) roundf(p.x + sway), py = (int) roundf(p.y);
      cv.set(px, py, col);
      if (face > 0.5f) cv.set(px + 1, py, scale(col, 180));
    }
  }
};

// Warp-speed starfield.
class Starfield : public Effect {
  struct Star { float x, y, z; };
  std::vector<Star> stars;
 public:
  void reset(int w, int h, Rng &r) override {
    Effect::reset(w, h, r);
    stars.resize(140);
    for (auto &s : stars) { s.x = r.range(-1, 1); s.y = r.range(-1, 1); s.z = r.range(0.05f, 1); }
  }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    const float v = 0.15f + c.rate / 90.f;
    const float cx = W / 2.f, cy = H / 2.f, f = W * 0.5f;
    for (auto &s : stars) {
      const float pz = s.z;
      s.z -= v * c.dt;
      if (s.z <= 0.02f) { s.x = r.range(-1, 1); s.y = r.range(-1, 1); s.z = 1; continue; }
      const float sx = cx + s.x / s.z * f, sy = cy + s.y / s.z * f * 0.5f;
      const float px = cx + s.x / pz * f, py = cy + s.y / pz * f * 0.5f;
      if (sx < -2 || sx > W + 2 || sy < -2 || sy > H + 2) { s.x = r.range(-1, 1); s.y = r.range(-1, 1); s.z = 1; continue; }
      const float b = clampf(1.5f - s.z, 0.3f, 1);
      const RGB col = scale(mix(RGB{255, 255, 255}, pal(*c.pal, (int) (hash01((int) (s.x * 1000), (int) (s.y * 1000)) * 255)), 90), (int) (c.level * b));
      const int steps = std::max(1, (int) (fabsf(sx - px) + fabsf(sy - py)));
      for (int i = 0; i <= steps; i++) {
        const float t = (float) i / steps;
        cv.splat(px + (sx - px) * t, py + (sy - py) * t, scale(col, (int) (80 + 175 * t)));
      }
    }
  }
};

class Plasma : public Effect {
 public:
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float t = c.ticks * 0.004f;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const float v = sinturn(x * 0.027f + t) + sinturn(y * 0.046f - t * 0.7f) + sinturn((x + y) * 0.018f + t * 0.5f) +
                      sinturn(sqrtf((float) ((x - W / 2) * (x - W / 2) + (y - H / 2) * (y - H / 2) * 4)) * 0.03f - t);
      const int idx = (int) ((v + 4) * 48 + t * 30);
      cv.set(x, y, scale(pal(*c.pal, idx), (int) (c.level * (0.55f + 0.45f * (0.5f + v / 8)))));
    }
  }
};

// Rockets, bursts, gravity, crackle.
class Fireworks : public Effect {
  struct P { float x, y, vx, vy, life, decay; RGB c; bool rocket; };
  std::vector<P> ps;
  float next = 0;
  Canvas trails;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); ps.clear(); next = 0.2f; trails.resize(w, h); }
  void render(Canvas &out, const FxCtx &c, Rng &r) override {
    Canvas &cv = trails;
    cv.fade((int) (255 * expf(-c.dt * 7.f)));
    const float sp = 0.6f + c.rate / 40.f;
    next -= c.dt * sp;
    if (next <= 0) {
      next = r.range(0.35f, 1.2f);
      ps.push_back({r.range(W * 0.15f, W * 0.85f), (float) H, r.range(-4, 4), -r.range(22, 30), 1, 0, pal(*c.pal, r.below(256)), true});
    }
    std::vector<P> born;
    for (auto &p : ps) {
      p.x += p.vx * c.dt * sp; p.y += p.vy * c.dt * sp;
      if (p.rocket) {
        p.vy += 18 * c.dt * sp;
        cv.splat(p.x, p.y, scale(RGB{255, 220, 160}, c.level));
        if (r.f() < 0.6f) born.push_back({p.x, p.y + 1, r.range(-2, 2), r.range(2, 6), 0.4f, 1.6f, RGB{255, 140, 40}, false});
        if (p.vy > -4 || p.y < H * 0.25f) {
          p.life = 0;
          const int n = 40 + r.below(40);
          const RGB c2 = r.f() < 0.4f ? pal(*c.pal, r.below(256)) : p.c;
          const float power = r.range(14, 24);
          for (int i = 0; i < n; i++) {
            const float a = r.range(0, 6.2831853f), s = power * (0.3f + 0.7f * sqrtf(r.f()));
            born.push_back({p.x, p.y, cosf(a) * s, sinf(a) * s * 0.8f, 1, r.range(0.45f, 0.8f), i % 3 ? p.c : c2, false});
          }
        }
      } else {
        p.vy += 12 * c.dt * sp;
        p.vx *= 1 - 1.4f * c.dt; p.vy *= 1 - 1.4f * c.dt;
        p.life -= p.decay * c.dt * sp;
        if (p.life > 0) {
          const float twinkle = p.life < 0.35f && r.f() < 0.3f ? 1.6f : 1.f;
          cv.splat(p.x, p.y, scale(mix(p.c, RGB{255, 255, 255}, (int) (std::max(0.f, p.life - 0.7f) * 500)), (int) (c.level * std::min(1.f, p.life * twinkle))));
        }
      }
    }
    ps.erase(std::remove_if(ps.begin(), ps.end(), [](const P &p) { return p.life <= 0; }), ps.end());
    ps.insert(ps.end(), born.begin(), born.end());
    if (ps.size() > 600) ps.erase(ps.begin(), ps.begin() + (ps.size() - 600));
    for (size_t k = 0; k < out.px.size(); k++) out.px[k] = add(out.px[k], cv.px[k]);
  }
};

// Lava lamp: metaballs drifting on slow sine paths.
class Lava : public Effect {
 public:
  void render(Canvas &cv, const FxCtx &c, Rng &) override {
    const float t = c.ticks * 0.006f;
    float bx[6], by[6], br[6];
    for (int i = 0; i < 6; i++) {
      bx[i] = W * (0.5f + 0.42f * sinturn(t * (0.13f + i * 0.037f) + i * 0.21f));
      by[i] = H * (0.5f + 0.55f * sinturn(t * (0.09f + i * 0.051f) + i * 0.37f));
      br[i] = H * (0.22f + 0.05f * (i % 3));
    }
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      float f = 0;
      for (int i = 0; i < 6; i++) { const float dx = x - bx[i], dy = (y - by[i]) * 1.3f; f += br[i] * br[i] / (dx * dx + dy * dy + 1); }
      RGB col;
      if (f > 1.f) {
        const int idx = (int) std::min(255.f, (f - 1) * 90);
        col = c.neon ? mix(RGB{255, 40, 0}, RGB{255, 200, 40}, idx) : pal(*c.pal, 40 + idx / 2);
        col = scale(col, c.level);
      } else {
        const float glow = f * f * f;
        col = scale(c.neon ? RGB{120, 0, 60} : scale(pal(*c.pal, 200), 120), (int) (c.level * glow * 0.6f + 6 * (1 - glow)));
      }
      cv.set(x, y, col);
    }
  }
};

// Conway's Life with age colours, fading deaths and reseeding when it stalls.
class Life : public Effect {
  std::vector<uint8_t> cells, next;
  std::vector<uint16_t> age;
  std::vector<float> ghost;
  float acc = 0;
  uint32_t last_hash = 0, last_hash2 = 0;
  int stale = 0, gens = 0;
 public:
  void reset(int w, int h, Rng &r) override {
    Effect::reset(w, h, r);
    cells.assign((size_t) w * h, 0); next = cells; age.assign(cells.size(), 0); ghost.assign(cells.size(), 0.f);
    seed(r);
  }
  void seed(Rng &r) {
    for (size_t k = 0; k < cells.size(); k++) { cells[k] = r.f() < 0.33f; age[k] = 0; }
    stale = 0; gens = 0;
  }
  void step(Rng &r) {
    uint32_t hsh = 2166136261U; int pop = 0;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      int n = 0;
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) if (dx || dy) n += cells[(size_t) ((y + dy + H) % H) * W + (x + dx + W) % W];
      const size_t k = (size_t) y * W + x;
      const bool alive = cells[k] ? (n == 2 || n == 3) : n == 3;
      next[k] = alive;
      if (cells[k] && !alive) ghost[k] = 1.f;
      age[k] = alive ? (uint16_t) std::min(1000, age[k] + 1) : 0;
      if (alive) { pop++; hsh = (hsh ^ (uint32_t) k) * 16777619U; }
    }
    cells.swap(next);
    gens++;
    stale = (hsh == last_hash || hsh == last_hash2) ? stale + 1 : 0;
    last_hash2 = last_hash; last_hash = hsh;
    if (stale > 12 || pop < W * H / 40 || gens > 1500) seed(r);
  }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    acc += c.dt * (2 + c.rate * 0.25f);
    while (acc >= 1) { acc -= 1; step(r); }
    for (size_t k = 0; k < cells.size(); k++) {
      ghost[k] *= expf(-c.dt * 4);
      RGB col{};
      if (cells[k]) col = scale(pal(*c.pal, std::min(200, age[k] * 6)), c.level);
      else if (ghost[k] > 0.03f) col = scale(pal(*c.pal, 230), (int) (c.level * ghost[k] * 0.35f));
      cv.px[k] = col;
    }
  }
};

// Raindrops on a pond: the two-buffer water ripple algorithm.
class Ripples : public Effect {
  std::vector<int16_t> a, b;
  float acc = 0;
 public:
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); a.assign((size_t) w * h, 0); b = a; }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    if (r.f() < c.dt * (0.8f + c.rate / 25.f)) {
      const int x = 2 + r.below(W - 4), y = 2 + r.below(H - 4);
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) a[(size_t) (y + dy) * W + x + dx] = (dx || dy) ? 700 : 1400;
    }
    acc += c.dt * 30;
    while (acc >= 1) {
      acc -= 1;
      for (int y = 1; y < H - 1; y++) for (int x = 1; x < W - 1; x++) {
        const size_t k = (size_t) y * W + x;
        int v = ((a[k - 1] + a[k + 1] + a[k - W] + a[k + W]) >> 1) - b[k];
        v -= v >> 5;
        b[k] = (int16_t) v;
      }
      a.swap(b);
    }
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const size_t k = (size_t) y * W + x;
      const int slope = x > 0 && x < W - 1 ? a[k + 1] - a[k - 1] : 0;
      const float lit = clampf(0.35f + slope / 450.f + a[k] / 1800.f, 0, 1);
      const RGB water = c.neon ? RGB{0, 90, 200} : pal(*c.pal, 140);
      cv.set(x, y, scale(mix(water, RGB{220, 240, 255}, (int) (std::max(0.f, lit - 0.5f) * 400)), (int) (c.level * lit)));
    }
  }
};

// Self-playing Pong clock: left score = hour, right score = minute. When the
// minute (or hour) changes, the losing paddle deliberately misses.
class Pong : public Effect {
  float bx = 0, by = 0, vx = 0, vy = 0, lp = 0, rp = 0, serve = 0;
  int shown_h = -1, shown_m = -1, want_h = 0, want_m = 0;
 public:
  int hour = 12, minute = 0;  // set by the engine each frame
  void reset(int w, int h, Rng &r) override { Effect::reset(w, h, r); lp = rp = h / 2.f; shown_h = shown_m = -1; serve_ball(r, 1); }
  void serve_ball(Rng &r, int dir) { bx = W / 2.f; by = H / 2.f; vx = 34.f * dir; vy = r.range(-14, 14); serve = 0.6f; }
  void render(Canvas &cv, const FxCtx &c, Rng &r) override {
    want_h = hour; want_m = minute;
    if (shown_h < 0) { shown_h = want_h; shown_m = want_m; }
    const bool right_must_win = want_m != shown_m && want_h == shown_h;  // minute changed: left misses
    const bool left_must_win = want_h != shown_h;                          // hour changed: right misses
    const float sp = 0.7f + c.rate / 60.f;
    const int ph = 8;
    if (serve > 0) serve -= c.dt;
    else {
      bx += vx * c.dt * sp; by += vy * c.dt * sp;
      if (by < 1) { by = 1; vy = fabsf(vy); }
      if (by > H - 2) { by = (float) (H - 2); vy = -fabsf(vy); }
    }
    auto track = [&](float &p, bool miss, bool coming) {
      float target = coming ? by : H / 2.f;
      if (miss) target = by + (by < H / 2.f ? 12 : -12);
      const float d = target - p, maxv = 40 * c.dt * sp;
      p += clampf(d, -maxv, maxv);
      p = clampf(p, ph / 2.f, H - ph / 2.f);
    };
    track(lp, right_must_win, vx < 0);
    track(rp, left_must_win, vx > 0);
    if (bx < 3 && vx < 0) {
      if (!right_must_win && fabsf(by - lp) <= ph / 2.f + 1) { vx = fabsf(vx); vy += (by - lp) * 3 + r.range(-3, 3); bx = 3; }
      else if (bx < -2) { shown_m = want_m; serve_ball(r, 1); }
    }
    if (bx > W - 4 && vx > 0) {
      if (!left_must_win && fabsf(by - rp) <= ph / 2.f + 1) { vx = -fabsf(vx); vy += (by - rp) * 3 + r.range(-3, 3); bx = (float) (W - 4); }
      else if (bx > W + 2) { shown_h = want_h; shown_m = want_m; serve_ball(r, -1); }
    }
    vy = clampf(vy, -26, 26);
    const RGB fg = scale(c.theme.primary, c.level), dim = scale(c.theme.primary, c.level / 4);
    for (int y = 0; y < H; y += 3) cv.set(W / 2, y, dim);
    char buf[8];
    snprintf(buf, sizeof buf, "%d", shown_h);
    draw_text(cv, W / 2 - 4 - text_width(buf), 1, buf, scale(pal(*c.pal, 20), c.level));
    snprintf(buf, sizeof buf, "%02d", shown_m);
    draw_text(cv, W / 2 + 4, 1, buf, scale(pal(*c.pal, 150), c.level));
    for (int i = 0; i < ph; i++) { cv.set(1, (int) (lp - ph / 2.f) + i, fg); cv.set(W - 2, (int) (rp - ph / 2.f) + i, fg); }
    if (serve <= 0 || ((int) (serve * 8) % 2)) cv.frect((int) roundf(bx - 1), (int) roundf(by - 1), 2, 2, scale(RGB{255, 255, 255}, c.level));
  }
};

inline std::unique_ptr<Effect> make_effect(const std::string &name) {
  if (name == "bouncing_text") return std::unique_ptr<Effect>(new Bounce());
  if (name == "rainbow_waves") return std::unique_ptr<Effect>(new RainbowWaves());
  if (name == "aurora") return std::unique_ptr<Effect>(new Aurora());
  if (name == "digital_rain") return std::unique_ptr<Effect>(new DigitalRain());
  if (name == "fire") return std::unique_ptr<Effect>(new Fire());
  if (name == "twinkle") return std::unique_ptr<Effect>(new Twinkle());
  if (name == "color_vortex") return std::unique_ptr<Effect>(new Vortex());
  if (name == "confetti") return std::unique_ptr<Effect>(new Confetti());
  if (name == "starfield") return std::unique_ptr<Effect>(new Starfield());
  if (name == "plasma") return std::unique_ptr<Effect>(new Plasma());
  if (name == "fireworks") return std::unique_ptr<Effect>(new Fireworks());
  if (name == "lava") return std::unique_ptr<Effect>(new Lava());
  if (name == "life") return std::unique_ptr<Effect>(new Life());
  if (name == "ripples") return std::unique_ptr<Effect>(new Ripples());
  if (name == "pong") return std::unique_ptr<Effect>(new Pong());
  return std::unique_ptr<Effect>(new Scanner());
}

// ------------------------------------------------------ music visualizers ---

// What the local microphone analyser heard this frame.
struct Sound {
  static const int N = 32;
  float band[N] = {0};  // 0..1, bass first
  float level = 0, bass = 0, mid = 0, treble = 0;
  bool beat = false;    // a beat landed since the last frame
  // Band at pos 0..1 (bass..treble), interpolated.
  float at(float pos) const {
    const float f = clampf(pos, 0, 1) * (N - 1);
    const int i = (int) f, j = std::min(N - 1, i + 1);
    return band[i] + (band[j] - band[i]) * (f - i);
  }
};

// The Music modes' colours: the effect palette (its dark stops lifted to
// full brightness, since the visualizers set brightness themselves), or a
// rainbow for neon.
inline RGB viz_color(const FxCtx &c, float t) {
  const int v = (int) (t * 255) & 255;
  if (c.neon) return hsv(v, 235, 255);
  const RGB p = pal(*c.pal, v);
  const int m = std::max({(int) p.r, (int) p.g, (int) p.b, 1});
  return m >= 220 ? p : rgb(p.r * 220 / m, p.g * 220 / m, p.b * 220 / m);
}
// Black -> indigo -> magenta -> orange -> yellow -> white, for intensity maps.
inline RGB inferno_color(float t) {
  static const RGB stops[] = {{0, 0, 0}, {30, 8, 80}, {130, 20, 120}, {230, 70, 40}, {255, 180, 30}, {255, 250, 200}};
  const float f = clampf(t, 0, 1) * 5;
  const int i = std::min(4, (int) f);
  return mix(stops[i], stops[i + 1], (int) ((f - i) * 255));
}

class Visualizer {
 public:
  virtual ~Visualizer() = default;
  virtual void reset(int w, int h) { W = w; H = h; }
  virtual void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &rng) = 0;

 protected:
  int W = 0, H = 0;
};

// 32 bars with falling peak caps, bass on the left.
class VizBars : public Visualizer {
  float bars[Sound::N] = {0}, peaks[Sound::N] = {0}, fall[Sound::N] = {0};
 public:
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &) override {
    const int n = Sound::N, bw = std::max(1, W / n), lit = std::max(1, bw - 1), ox = (W - n * bw + 1) / 2;
    const float hue0 = c.ms / 30000.f;
    for (int i = 0; i < n; i++) {
      const float v = s.band[i];
      bars[i] = v > bars[i] ? v : std::max(v, bars[i] - c.dt * 2.2f);
      if (bars[i] >= peaks[i]) { peaks[i] = bars[i]; fall[i] = 0; }
      else { fall[i] += c.dt * 2.6f; peaks[i] = std::max(0.f, peaks[i] - fall[i] * c.dt); }
      const float hpx = bars[i] * H;
      const int full = (int) hpx, x = ox + i * bw;
      for (int y = 0; y <= full && y < H; y++) {
        const float frac = (float) y / (H - 1);
        RGB col = c.neon ? hsv(96 - (int) (frac * 100), 240, 255) : viz_color(c, hue0 + frac * 0.55f);
        col = scale(col, (int) (110 + 145 * frac));
        if (y == full) col = scale(col, (int) ((hpx - full) * 255));  // soft top edge
        for (int k = 0; k < lit; k++) cv.set(x + k, H - 1 - y, col);
      }
      if (peaks[i] > 0.03f) {
        const int py = H - 1 - std::min(H - 1, (int) (peaks[i] * (H - 1)) + 1);
        for (int k = 0; k < lit; k++) cv.set(x + k, py, RGB{235, 240, 255});
      } else for (int k = 0; k < lit; k++) cv.set(x + k, H - 1, scale(viz_color(c, hue0), 40));
    }
  }
};

// Spectrogram as a river: time flows right to left, bass along the middle,
// treble towards the top and bottom edges. Columns are averaged, blended with
// the previous one and blurred across bands so it flows instead of speckling;
// the colour ramp keeps a brightness floor because the panel's gamma swallows
// dim colours.
class VizWaterfall : public Visualizer {
  std::vector<uint8_t> hist;  // W columns x Sound::N bands
  float slice[Sound::N] = {0}, prev[Sound::N] = {0};
  int slice_n = 0;
  uint32_t last = 0;
 public:
  void reset(int w, int h) override { Visualizer::reset(w, h); hist.assign((size_t) w * Sound::N, 0); last = 0; slice_n = 0; }
  static RGB ramp(float t) {  // deep blue -> cyan -> green -> yellow -> red -> white
    static const RGB stops[] = {{0, 20, 160}, {0, 150, 255}, {0, 230, 90}, {255, 230, 0}, {255, 50, 0}, {255, 235, 220}};
    const float f = clampf(t, 0, 1) * 5;
    const int i = std::min(4, (int) f);
    return mix(stops[i], stops[i + 1], (int) ((f - i) * 255));
  }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &) override {
    const int n = Sound::N;
    for (int b = 0; b < n; b++) slice[b] += s.band[b];
    slice_n++;
    if (!last || c.ms - last > 500) last = c.ms;
    while (c.ms - last >= 54) {
      last += 54;
      float col[Sound::N];
      for (int b = 0; b < n; b++) col[b] = slice_n ? slice[b] / slice_n : prev[b];
      for (int b = 0; b < n; b++) {
        const float blur = (col[std::max(0, b - 1)] + 2 * col[b] + col[std::min(n - 1, b + 1)]) / 4;
        prev[b] = prev[b] * 0.35f + blur * 0.65f;
      }
      std::memmove(hist.data(), hist.data() + n, hist.size() - n);
      for (int b = 0; b < n; b++) { hist[hist.size() - n + b] = (uint8_t) (prev[b] * 255); slice[b] = 0; }
      slice_n = 0;
    }
    const float mid = (H - 1) / 2.f;
    for (int x = 0; x < W; x++) {
      const uint8_t *col = &hist[(size_t) x * n];
      const float age = 1 - 0.35f * (float) (W - 1 - x) / W;  // older = a little dimmer
      for (int y = 0; y < H; y++) {
        const float f = fabsf(y - mid) / mid * (n - 1);
        const int b0 = (int) f, b1 = std::min(n - 1, b0 + 1);
        const float v = (col[b0] + (col[b1] - col[b0]) * (f - b0)) / 255.f;
        const float g = powf(clampf((v - 0.16f) / 0.8f, 0, 1), 1.35f);  // red/white only for peaks
        if (g <= 0) continue;
        const RGB hue = c.neon ? ramp(g) : viz_color(c, 0.1f + g * 0.6f);
        cv.set(x, y, scale(hue, (int) (255 * age * (0.4f + 0.6f * g))));
      }
    }
  }
};

// Every beat sends a ring out from the middle across the whole sign; each
// ring is bent by the spectrum it was born with (bass sideways, treble up
// and down). A core glows with the bass.
class VizRings : public Visualizer {
  struct Ring { float r, speed, width, hue, shape[8]; };
  std::vector<Ring> rings;
  std::vector<float> dist, side;  // per pixel: distance from centre, 0 = sideways .. 1 = vertical
  float hue = 0, quiet = 0, core = 0;
 public:
  void reset(int w, int h) override {
    Visualizer::reset(w, h);
    dist.resize((size_t) w * h); side.resize((size_t) w * h); rings.clear();
    const float cx = (w - 1) / 2.f, cy = (h - 1) / 2.f;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      const float dx = x - cx, dy = (y - cy) * 1.15f, d = sqrtf(dx * dx + dy * dy);
      dist[(size_t) y * w + x] = d;
      side[(size_t) y * w + x] = d > 0 ? fabsf(dy) / d : 0;
    }
  }
  void spawn(const Sound &s, float strength) {
    Ring r{2.f, 34.f + 40.f * strength, 1.4f + 1.6f * strength, hue, {}};
    for (int k = 0; k < 8; k++) r.shape[k] = s.at(k / 7.f);
    rings.push_back(r);
    if (rings.size() > 14) rings.erase(rings.begin());
    hue += 0.09f;
  }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &) override {
    quiet += c.dt;
    if (s.beat) { spawn(s, clampf(0.4f + s.bass, 0, 1)); quiet = 0; }
    else if (quiet > (s.level > 0.25f ? 0.45f : 2.6f)) { spawn(s, 0.15f + 0.3f * s.level); quiet = 0; }  // songs without drums
    for (auto &r : rings) r.r += r.speed * c.dt;
    rings.erase(std::remove_if(rings.begin(), rings.end(), [](const Ring &r) { return r.r > 62; }), rings.end());
    core += ((2.f + s.bass * 6.f) - core) * std::min(1.f, c.dt * 14);
    const RGB core_c = viz_color(c, hue);
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const size_t k = (size_t) y * W + x;
      const float d = dist[k], sd = side[k] * 7;
      const int si = std::min(6, (int) sd);
      float cr = 0, cg = 0, cb = 0;
      const float glow = clampf(1 - d / core, 0, 1) + 0.18f * s.level * clampf(1 - d / 48, 0, 1);
      cr += core_c.r * glow; cg += core_c.g * glow; cb += core_c.b * glow;
      for (const auto &r : rings) {
        const float bend = r.shape[si] + (r.shape[si + 1] - r.shape[si]) * (sd - si);
        const float off = fabsf(d - (r.r + bend * 7.f));
        if (off >= r.width) continue;
        const float a = (1 - off / r.width) * clampf(1.15f - r.r / 60.f, 0, 1);
        const RGB rc = viz_color(c, r.hue + side[k] * 0.12f);
        cr += rc.r * a; cg += rc.g * a; cb += rc.b * a;
      }
      if (cr + cg + cb > 3) cv.set(x, y, rgb((int) cr, (int) cg, (int) cb));
    }
  }
};

// A galaxy: ~150 stars on wide ellipses with comet trails. Inner stars ride
// the bass and orbit fastest, outer ones the treble; beats kick the disc
// outward and it springs back.
class VizOrbit : public Visualizer {
  struct Star { float r, a, push, vel; };
  std::vector<Star> stars;
  Canvas trail;
  float spin = 0, flash = 0;
 public:
  void reset(int w, int h) override {
    Visualizer::reset(w, h);
    trail.resize(w, h);
    stars.clear();
    Rng r;
    for (int i = 0; i < 150; i++) stars.push_back({0.06f + 0.94f * sqrtf(r.f()), r.range(0, 6.2831853f), 0, 0});
  }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &) override {
    trail.fade((int) (175 + 50 * s.level));
    if (s.beat) { flash = 1; for (auto &st : stars) st.vel += 1.1f * (0.4f + s.bass); }
    flash = std::max(0.f, flash - c.dt * 3);
    spin += c.dt * (0.25f + 1.6f * s.level);
    const float cx = (W - 1) / 2.f, cy = (H - 1) / 2.f, rx = W / 2.f - 1, ry = H / 2.f - 0.5f;
    for (auto &st : stars) {
      // Spring back towards the home orbit.
      st.vel += (-st.push * 30.f - st.vel * 7.f) * c.dt;
      st.push += st.vel * c.dt;
      st.a += c.dt * (0.35f + 2.2f * s.level) * 0.45f / (0.2f + st.r);
      const float R = st.r * (1 + st.push * 0.35f);
      const float v = s.at(st.r);
      const float x = cx + cosf(st.a) * R * rx, y = cy + sinf(st.a) * R * ry;
      trail.splat(x, y, scale(viz_color(c, st.r * 0.6f + spin * 0.03f), (int) (110 + 145 * v)));
    }
    // Core: bass-sized sun, a ring flash on each beat.
    const RGB sun = viz_color(c, spin * 0.03f);
    const float cr = 1.2f + s.bass * 2.6f;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const float dx = (x - cx) / 2.2f, dy = y - cy, d = sqrtf(dx * dx + dy * dy);
      RGB p = trail.at(x, y);
      if (d < cr + 2) p = add(p, scale(add(sun, RGB{70, 70, 70}), (int) (255 * clampf((cr + 2 - d) / 2, 0, 1))));
      if (flash > 0) {
        const float fr = (1 - flash) * 10 + 2;
        if (fabsf(d - fr) < 1) p = add(p, scale(sun, (int) (flash * 200 * (1 - fabsf(d - fr)))));
      }
      cv.set(x, y, p);
    }
  }
};

// "Unknown Pleasures": recent spectra as stacked mountain lines receding into
// the distance, bass in the middle, each line hiding the ones behind it.
class VizRidgeline : public Visualizer {
  static const int L = 11;
  std::vector<std::vector<float>> lines;  // [0] = newest
  float hold[Sound::N] = {0};
  uint32_t last = 0;
 public:
  void reset(int w, int h) override { Visualizer::reset(w, h); lines.assign(L + 1, std::vector<float>(Sound::N, 0)); last = 0; }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &) override {
    const uint32_t step = 95;
    for (int b = 0; b < Sound::N; b++) hold[b] = std::max(hold[b], s.band[b]);
    if (!last || c.ms - last > 1000) last = c.ms;
    while (c.ms - last >= step) {
      last += step;
      lines.pop_back();
      lines.insert(lines.begin(), std::vector<float>(hold, hold + Sound::N));
      std::fill(hold, hold + Sound::N, 0.f);
    }
    const float frac = (float) (c.ms - last) / step, cx = (W - 1) / 2.f;
    // The newest line follows the live sound; older ones glide back.
    std::vector<float> live(Sound::N);
    for (int b = 0; b < Sound::N; b++) live[b] = std::max(s.band[b], lines[0][b] * (1 - frac));
    for (int i = L; i >= 0; i--) {
      const float age = i + frac, z = age / L;
      if (z > 1) continue;
      const std::vector<float> &spec = i == 0 ? live : lines[i - 1];
      const float base = (H - 1) - age * 2.75f, half = (W / 2.f) * (1 - z * 0.42f), amp = 17.f * (1 - z * 0.45f);
      const int bright = (int) (255 * (1 - z) * (1 - z * 0.3f));
      int prev_top = -1;
      for (int x = 0; x < W; x++) {
        const float u = (x - cx) / half, au = fabsf(u);
        float hgt = 0;
        if (au < 1) {
          const float taper = 0.5f + 0.5f * cosf(au * 3.14159f);
          const float f = powf(au, 1.7f) * (Sound::N - 1);  // bass gets the wide middle
          const int b0 = (int) f, b1 = std::min(Sound::N - 1, b0 + 1);
          hgt = (spec[b0] + (spec[b1] - spec[b0]) * (f - b0)) * taper * amp;
        }
        const float topf = base - hgt;
        const int top = (int) floorf(topf);
        for (int y = std::max(0, top + 1); y <= (int) base && y < H; y++) cv.set(x, y, RGB{});  // hide what's behind
        const RGB col = scale(viz_color(c, 0.5f + hgt / 22.f + c.ms / 60000.f), bright);
        const int from = prev_top < 0 ? top : std::min(top, prev_top + 1), to = prev_top < 0 ? top : std::max(top, prev_top - 1);
        for (int y = from; y <= to; y++) cv.set(x, y, col);
        prev_top = top;
      }
    }
  }
};

// Fire fed by the spectrum: the bass burns in the middle, treble at the
// edges; beats throw embers.
class VizInferno : public Visualizer {
  std::vector<uint8_t> heat;  // W x (H + 2), bottom two rows are the fuel
  struct Ember { float x, y, vx, vy, life; };
  std::vector<Ember> embers;
 public:
  void reset(int w, int h) override { Visualizer::reset(w, h); heat.assign((size_t) w * (h + 2), 0); embers.clear(); }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &rng) override {
    const int R = H + 2;
    auto hp = [&](int x, int y) -> uint8_t & { return heat[(size_t) y * W + x]; };
    const float cx = (W - 1) / 2.f;
    for (int x = 0; x < W; x++) {
      const float v = s.at(fabsf(x - cx) / (W / 2.f));
      const int fuel = (int) (powf(std::min(1.f, v * 1.15f), 1.4f) * 255 * (0.75f + 0.25f * rng.f())) + (s.beat ? 50 : 0) + 30;
      hp(x, R - 1) = hp(x, R - 2) = (uint8_t) std::min(255, fuel);
    }
    // Heat rises: each cell takes a blur of the cells below it, drifts
    // sideways at random and cools.
    for (int y = 0; y < R - 2; y++) for (int x = 0; x < W; x++) {
      const int xl = x > 0 ? x - 1 : x, xr = x < W - 1 ? x + 1 : x;
      const int src = (hp(x, y + 1) * 2 + hp(xl, y + 1) + hp(xr, y + 1) + hp(x, y + 2) * 2) / 6;
      const int dx = std::max(0, std::min(W - 1, x + rng.below(3) - 1));
      hp(dx, y) = (uint8_t) std::max(0, src - rng.below(19));
    }
    if (s.beat) for (int i = 0; i < 6 + (int) (s.bass * 10); i++)
      embers.push_back({cx + rng.range(-30, 30), (float) H - 2, rng.range(-6, 6), -rng.range(14, 34), 1});
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      const int h = hp(x, y);
      if (h < 6) continue;
      cv.set(x, y, c.neon ? heat_color(h) : scale(viz_color(c, h / 400.f), std::min(255, h * 2)));
    }
    for (auto &e : embers) {
      e.x += e.vx * c.dt; e.y += e.vy * c.dt; e.vy += 6 * c.dt; e.life -= c.dt * 0.8f;
      if (e.life > 0) cv.splat(e.x, e.y, scale(c.neon ? RGB{255, 200, 90} : viz_color(c, 0.8f), (int) (e.life * 255)));
    }
    embers.erase(std::remove_if(embers.begin(), embers.end(), [](const Ember &e) { return e.life <= 0 || e.y < -2; }), embers.end());
  }
};

// Hyperspace: streaking stars that speed up with the volume and lurch on
// each beat. A star's colour and brightness follow the band its angle maps to.
class VizWarp : public Visualizer {
  struct Star { float x, y, z, band; };
  std::vector<Star> stars;
  float boost = 0;
  void place(Star &s, Rng &r, bool anywhere) {
    const float a = r.range(0, 6.2831853f), d = r.range(0.15f, 1.f);
    s.x = cosf(a) * d; s.y = sinf(a) * d; s.z = anywhere ? r.range(0.1f, 1.f) : 1.f;
    s.band = fabsf(sinf(a));  // sideways = bass, up/down = treble
  }
 public:
  void reset(int w, int h) override {
    Visualizer::reset(w, h);
    Rng r;
    stars.assign(150, Star{});
    for (auto &s : stars) place(s, r, true);
  }
  void render(Canvas &cv, const Sound &s, const FxCtx &c, Rng &rng) override {
    if (s.beat) boost = std::min(2.5f, boost + 0.9f + s.bass);
    boost = std::max(0.f, boost - c.dt * 2.2f);
    const float speed = 0.15f + 0.9f * s.level + boost * 0.6f;
    if (boost > 0.5f) cv.fill(scale(viz_color(c, c.ms / 40000.f), (int) ((boost - 0.5f) * 10)));
    const float cx = (W - 1) / 2.f, cy = (H - 1) / 2.f, fx = W * 0.32f, fy = H * 0.45f;
    for (auto &st : stars) {
      const float z0 = st.z;
      st.z -= speed * c.dt;
      if (st.z < 0.04f) { place(st, rng, false); continue; }
      const float x0 = cx + st.x / z0 * fx, y0 = cy + st.y / z0 * fy, x1 = cx + st.x / st.z * fx, y1 = cy + st.y / st.z * fy;
      if (x1 < -2 || x1 > W + 1 || y1 < -2 || y1 > H + 1) { place(st, rng, false); continue; }
      const float v = s.at(st.band);
      const RGB col = scale(mix(RGB{200, 210, 255}, viz_color(c, st.band * 0.5f + c.ms / 40000.f), (int) (v * 255)),
                            (int) (255 * clampf((1.2f - st.z) * 1.8f, 0.45f, 1) * (0.65f + 0.35f * v)));
      const int steps = std::max(1, (int) std::max(fabsf(x1 - x0), fabsf(y1 - y0)));
      for (int k = 0; k <= steps; k++) {
        const float t = (float) k / steps;
        cv.splat(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, scale(col, (int) (90 + 165 * t)));
      }
    }
  }
};

// The local Music modes. "mix" rotates through them every 40 s.
inline const char *const *viz_modes(int &n) {
  static const char *const modes[] = {"pulse_rings", "orbit", "waterfall", "bars", "ridgeline", "inferno", "warp"};
  n = 7;
  return modes;
}
inline std::string viz_pick(const std::string &mode, uint32_t ms) {
  if (mode != "mix") return mode;
  int n = 0;
  const char *const *modes = viz_modes(n);
  return modes[(ms / 40000U) % (uint32_t) n];
}
inline std::unique_ptr<Visualizer> make_visualizer(const std::string &name) {
  if (name == "orbit") return std::unique_ptr<Visualizer>(new VizOrbit());
  if (name == "waterfall") return std::unique_ptr<Visualizer>(new VizWaterfall());
  if (name == "bars" || name == "spectrum") return std::unique_ptr<Visualizer>(new VizBars());
  if (name == "ridgeline") return std::unique_ptr<Visualizer>(new VizRidgeline());
  if (name == "inferno") return std::unique_ptr<Visualizer>(new VizInferno());
  if (name == "warp") return std::unique_ptr<Visualizer>(new VizWarp());
  return std::unique_ptr<Visualizer>(new VizRings());
}

// ---------------------------------------------------------------- engine ---

class Engine {
 public:
  Canvas frame;  // what the panel shows after render()

  void render(const Inputs &in, int width, int height) {
    if (frame.w != width || frame.h != height) {
      frame.resize(width, height); cur.resize(width, height); from.resize(width, height);
      fx.reset(); fx_name.clear();
    }
    const float dt = last_ms ? clampf((in.ms - last_ms) / 1000.f, 0.f, 0.1f) : 0.03f;
    last_ms = in.ms;
    theme = Theme{hex(in.background, RGB{}), hex(in.primary, RGB{230, 232, 237}), hex(in.secondary, RGB{0, 128, 255}),
                  hex(in.accent, RGB{255, 176, 0}), hex(in.critical, RGB{255, 32, 0})};
    W = width; H = height; ms = in.ms;

    // Scene identity decides transitions and when scrolling text restarts.
    const std::string sig = signature(in);
    if (sig != last_sig) {
      const bool to_alert = in.scene == "notification";
      const bool from_alert = last_sig.rfind("notification", 0) == 0;
      if (!last_sig.empty() && !in.booting) {
        from.px = frame.px;
        tr_start = in.ms;
        tr_kind = to_alert ? 1 : (from_alert ? 2 : 0);
        tr_len = to_alert ? 320 : (from_alert ? 600 : 700);
      }
      last_sig = sig;
      scene_epoch = in.ms;
    }

    cur.clear_clip();
    cur.fill(theme.bg);
    draw_scene(cur, in, dt);
    cur.clear_clip();

    // Compose the transition (if any) into the visible frame.
    const uint32_t age = in.ms - tr_start;
    if (tr_len && age < tr_len) {
      const float t = ease((float) age / tr_len);
      if (tr_kind == 1) {  // alert drops in from the top with a bright edge
        const int edge = (int) (t * (H + 1));
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) frame.at(x, y) = y < edge ? cur.at(x, y) : from.at(x, y);
        if (edge < H) for (int x = 0; x < W; x++) frame.at(x, edge) = add(frame.at(x, edge), scale(alert_color(in), 200));
      } else if (tr_kind == 2) {  // alert dissolves pixel by pixel
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) frame.at(x, y) = hash01(x, y, 3) < t ? cur.at(x, y) : from.at(x, y);
      } else {
        const int a = (int) (t * 255);
        for (size_t k = 0; k < frame.px.size(); k++) frame.px[k] = mix(from.px[k], cur.px[k], a);
      }
    } else {
      tr_len = 0;
      frame.px.swap(cur.px);
    }
  }

 private:
  Canvas cur, from;
  Theme theme;
  int W = 0, H = 0;
  uint32_t ms = 0, last_ms = 0, scene_epoch = 0, tr_start = 0, tr_len = 0;
  int tr_kind = 0;
  std::string last_sig;
  Rng rng;
  std::unique_ptr<Effect> fx;
  std::string fx_name;
  Pong *pong = nullptr;  // fx when it is Pong (no RTTI on ESP-IDF)
  float fx_ticks = 0;
  // Morphing clock digits.
  struct Morph { char from = ' ', to = ' '; uint32_t start = 0; };
  Morph morph[8];
  std::string shown_time;
  // Music smoothing.
  float bars[16] = {0}, peaks[16] = {0};
  std::unique_ptr<Visualizer> viz;
  std::string viz_name;
  uint32_t seen_beats = 0;

  std::string signature(const Inputs &in) const {
    std::string s = in.scene;
    if (!in.claimed) s = "claim";
    else if (in.booting) s = "boot";
    else if (in.scene == "notification") s += "|" + in.title + "|" + in.detail;
    else if (in.scene == "effect") s += "|" + in.effect;
    else if (in.scene == "music") s += "|" + in.music_mode + "|" + viz_pick(local_mode(in), in.ms);
    else if (in.scene == "countdown") s += "|" + in.count_state + "|" + in.title;
    s += "|" + in.background + in.primary + in.secondary;  // theme switches crossfade
    return s;
  }
  // "local_<mode>" = the sign's own microphones; "" for Studio-sent bands.
  static std::string local_mode(const Inputs &in) {
    if (in.music_mode == "local") return "bars";
    return in.music_mode.rfind("local_", 0) == 0 ? in.music_mode.substr(6) : "";
  }
  RGB alert_color(const Inputs &in) const {
    return in.severity == "critical" ? theme.critical : (in.severity == "warning" ? theme.accent : theme.primary);
  }

  // One line of small text: centred when it fits, otherwise a marquee that
  // starts at the right edge when the scene (or text) appears.
  void line(Canvas &cv, const std::string &text, int y, RGB c, int left, int right, uint32_t epoch) {
    if (text.empty()) return;
    const int tw = text_width(text), avail = right - left;
    if (tw <= avail) { draw_text(cv, left + (avail - tw + 1) / 2, y, text, c); return; }
    const int span = tw + avail + 8;
    const int x = right - (int) (((ms - epoch) / 55U) % (uint32_t) span);
    cv.clip(left, 0, avail, H);
    draw_text(cv, x, y, text, c);
    cv.clear_clip();
  }

  void draw_scene(Canvas &cv, const Inputs &in, float dt) {
    if (in.booting) return splash(cv, in);
    if (!in.claimed) {
      line(cv, "COREVIEW BEACON", 3, theme.primary, 0, W, scene_epoch);
      line(cv, "CLAIM " + in.claim_code, H - 12, theme.secondary, 0, W, scene_epoch);
      return;
    }
    if (in.scene == "scoreboard" && W == 96 && H == 32) {
      const auto &board = coreview_scoreboard::state();
      coreview_scoreboard::render(board, in.ms - board.ticker_epoch, [&](int x, int y, uint32_t c) { cv.set(x, y, from_u32(c)); });
      // The scoreboard font has no lowercase; redraw its ticker lane with ours.
      if (!board.ticker.empty()) {
        cv.frect(0, 24, W, H - 24, from_u32(0x050605));
        const int tw = text_width(board.ticker), span = std::max(W, tw) + 48;
        const int off = (int) ((uint64_t) ((in.ms - board.ticker_epoch) * (double) board.speed / 1000) % (uint64_t) span);
        draw_text(cv, -off, 24, board.ticker, from_u32(0xFFAD21));
        draw_text(cv, span - off, 24, board.ticker, from_u32(0xFFAD21));
      }
      return;
    }
    const bool has_ticker = !in.ticker.empty();
    if (in.scene == "effect") effect(cv, in, dt);
    else if (in.scene == "clock") clock(cv, in, has_ticker);
    else if (in.scene == "music") music(cv, in, dt, has_ticker);
    else if (in.scene == "notification") notification(cv, in, has_ticker);
    else if (in.scene == "countdown") { countdown(cv, in); return; }
    else {
      const RGB c = alert_color(in);
      line(cv, in.title, 3, c, 2, W - 2, scene_epoch);
      if (!has_ticker) line(cv, in.detail, H - 11, c, 2, W - 2, scene_epoch);
    }
    if (has_ticker && in.scene != "effect") ticker(cv, in);
  }

  void ticker(Canvas &cv, const Inputs &in) {
    const bool notif = in.scene == "notification";
    const int y = notif ? H - 10 : (in.scene == "music" ? H - 9 : (H >= 30 ? 14 : H - 9));
    const int left = notif ? 3 : 0, right = notif ? W - 3 : W;
    const int tw = text_width(in.ticker), span = tw + (right - left) + 8;
    static std::string last_text;
    static uint32_t epoch = 0;
    if (in.ticker != last_text) { last_text = in.ticker; epoch = ms; }
    const int x = right - (int) (((ms - epoch) / 55U) % (uint32_t) span);
    if (in.scene == "music" && !local_mode(in).empty()) cv.frect(0, y - 1, W, H - y + 1, theme.bg);  // over a full-canvas visualizer
    cv.clip(left, 0, right - left, notif ? H - 2 : H);
    draw_text(cv, x, y, in.ticker, alert_color(in));
    cv.clear_clip();
  }

  void splash(Canvas &cv, const Inputs &in) {
    const float t = in.boot_elapsed / 1000.f;
    const std::string word = "COREVIEW";
    const int tw = text_width(word), x0 = W / 2 - tw / 2, y0 = std::max(0, H / 2 - 10);
    // Letters fade in left to right with a white flash.
    Canvas &c = cv;
    int x = x0;
    for (size_t i = 0; i < word.size(); i++) {
      const float lt = clampf((t - 0.12f * i) / 0.35f, 0, 1);
      const RGB col = mix(RGB{255, 255, 255}, RGB{0, 230, 255}, (int) (lt * 255));
      x = draw_text(c, x, y0, std::string(1, word[i]), scale(col, (int) (lt * 255)));
    }
    line(cv, "BEACON 2.0", y0 + 10, scale(RGB{0, 150, 130}, (int) (clampf(t - 1.0f, 0, 1) * 255)), 0, W, 0);
    const int bar_y = H - 5, fillw = (int) ((W - 4) * clampf(t / 3.f, 0, 1));
    c.rect(1, bar_y - 1, W - 2, 4, RGB{0, 50, 70});
    for (int i = 0; i < fillw; i++) c.vline(2 + i, bar_y, bar_y + 1, mix(RGB{0, 120, 255}, RGB{0, 255, 160}, i * 255 / std::max(1, W - 4)));
    if (fillw > 0 && fillw < W - 4) for (int k = 0; k < 3; k++) c.splat(2 + fillw + rng.range(-1, 1), bar_y + rng.range(-2, 2), RGB{200, 255, 255});
  }

  void clock(Canvas &cv, const Inputs &in, bool has_ticker) {
    const RGB c = alert_color(in);
    if (!in.time_valid) { line(cv, "WAITING FOR TIME", H / 2 - 4, c, 0, W, scene_epoch); return; }
    int h12 = in.hour % 12;
    if (h12 == 0) h12 = 12;
    char buf[8];
    snprintf(buf, sizeof buf, "%d:%02d", h12, in.minute);
    std::string now = buf;
    if (now.size() != shown_time.size()) {  // 9:59 -> 10:00 changes layout; no morph
      shown_time = now;
      for (auto &m : morph) m = Morph{};
      for (size_t i = 0; i < now.size(); i++) morph[i].from = morph[i].to = now[i];
    }
    for (size_t i = 0; i < now.size(); i++) if (now[i] != morph[i].to) {
      morph[i].from = morph[i].to; morph[i].to = now[i]; morph[i].start = ms;
    }
    shown_time = now;
    const char *ampm = in.hour < 12 ? "AM" : "PM";
    const int tw = big_width(now), aw = text_width(ampm), total = tw + 3 + aw;
    const int x0 = W / 2 - total / 2, y0 = has_ticker ? 0 : 1;
    int x = x0;
    std::vector<std::pair<int, int>> a, b;
    for (size_t i = 0; i < now.size(); i++) {
      const char ch = now[i];
      const int gw = beacon_fonts::big_index[ch - 32][1];
      if (ch == ':') {  // colon breathes once a second
        const float br = 0.45f + 0.55f * (0.5f + 0.5f * cosf((in.ms % 1000) / 1000.f * 6.2831853f));
        big_pixels(':', a);
        for (auto &p : a) cv.set(x + p.first, y0 + p.second, scale(c, (int) (255 * br)));
      } else {
        const float t = morph[i].start ? (ms - morph[i].start) / 650.f : 1.f;
        if (t >= 1.f || morph[i].from == morph[i].to) {
          big_pixels(ch, a);
          for (auto &p : a) cv.set(x + p.first, y0 + p.second, c);
        } else {
          // Every lit pixel of the old digit flows to a pixel of the new one.
          big_pixels(morph[i].from, a); big_pixels(morph[i].to, b);
          const size_t n = std::max(a.size(), b.size());
          for (size_t k = 0; k < n; k++) {
            const auto &pa = a[a.empty() ? 0 : k * a.size() / n], &pb = b[b.empty() ? 0 : k * b.size() / n];
            const float delay = 0.25f * (float) k / n, e = ease((t - delay) / (1 - 0.25f));
            cv.splat(x + pa.first + (pb.first - pa.first) * e, y0 + pa.second + (pb.second - pa.second) * e, c);
          }
        }
      }
      x += gw + 2;
    }
    const int ax = x0 + tw + 3;
    draw_text(cv, ax, y0, ampm, c);
    snprintf(buf, sizeof buf, "%02d", in.second);
    draw_text(cv, ax, y0 + 7, buf, scale(theme.secondary, 150));
    if (!has_ticker || H >= 30) line(cv, in.title, H - 9, theme.secondary, 0, W, scene_epoch);
  }

  // Kitchen timer: big M:SS (H:MM:SS from an hour up) counted on the Beacon's
  // own clock, a progress line, the timer's name. Paused dims the digits;
  // done flashes the border and the zeros.
  void countdown(Canvas &cv, const Inputs &in) {
    const bool paused = in.count_state == "paused";
    int64_t left = paused ? in.count_remaining : 0;
    if (in.count_state == "running") {
      if (!in.time_valid) { line(cv, "WAITING FOR TIME", H / 2 - 4, theme.primary, 0, W, scene_epoch); return; }
      left = std::max<int64_t>(0, in.count_ends - in.epoch);
    }
    const bool done = in.count_state == "done" || (in.count_state == "running" && left <= 0);
    const int t = (int) std::min<int64_t>(left, 359999);
    char buf[16];
    if (t >= 3600) snprintf(buf, sizeof buf, "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60);
    else snprintf(buf, sizeof buf, "%d:%02d", t / 60, t % 60);
    const std::string digits = buf;
    const bool flash = ((in.ms - scene_epoch) / 400U) % 2U == 0U;
    if (done) {
      cv.rect(0, 0, W, H, theme.accent);
      if (flash) cv.rect(1, 1, W - 2, H - 2, theme.accent);
    }
    RGB c = done ? theme.accent : (paused ? scale(theme.secondary, 150) : theme.primary);
    if (!done || flash) {
      std::vector<std::pair<int, int>> px;
      int x = W / 2 - big_width(digits) / 2;
      for (char ch : digits) {
        big_pixels(ch, px);
        for (auto &p : px) cv.set(x + p.first, 2 + p.second, c);
        x += beacon_fonts::big_index[ch - 32][1] + 2;
      }
    }
    if (!done && in.count_duration > 0) {  // what's left, shrinking from the right
      const int full = W - 8, fill = (int) (full * std::min<int64_t>(left, in.count_duration) / in.count_duration);
      cv.hline(4, 4 + full - 1, 18, scale(theme.secondary, 60));
      if (fill > 0) cv.hline(4, 4 + fill - 1, 18, paused ? theme.accent : theme.secondary);
    }
    std::string label = paused ? "PAUSED" : in.title;
    if (done) label = text_width(in.title + " DONE") <= W - 4 ? in.title + " DONE" : "TIMER DONE";
    line(cv, label, H - 10, done || paused ? theme.accent : theme.secondary, 2, W - 2, scene_epoch);
  }

  void effect(Canvas &cv, const Inputs &in, float dt) {
    if (!fx || fx_name != in.effect) {
      fx = make_effect(in.effect); fx_name = in.effect; fx->reset(W, H, rng);
      pong = in.effect == "pong" ? static_cast<Pong *>(fx.get()) : nullptr;
    }
    const int speed = std::max(1, std::min(100, in.speed));
    FxCtx c;
    c.ms = in.ms; c.dt = dt;
    c.rate = 1000.f / (111 - speed);
    fx_ticks += dt * c.rate;
    c.ticks = fx_ticks;
    c.intensity = std::max(1, std::min(100, in.intensity));
    c.level = c.intensity * 255 / 100;
    c.pal = &palette_named(in.palette);
    c.neon = c.pal->n == 0;
    c.word = in.title.empty() ? "COREVIEW" : in.title;
    c.theme = theme;
    if (pong) { const int h12 = in.hour % 12; pong->hour = h12 ? h12 : 12; pong->minute = in.minute; }
    fx->render(cv, c, rng);
  }

  // The sign's own microphones: a full-canvas visualizer, no caption.
  void local_music(Canvas &cv, const Inputs &in, float dt) {
    if (!in.audio_band || !in.audio_active) { line(cv, "WAITING FOR AUDIO", H / 2 - 4, theme.secondary, 0, W, scene_epoch); return; }
    const std::string name = viz_pick(local_mode(in), in.ms);
    if (!viz || viz_name != name) { viz = make_visualizer(name); viz_name = name; viz->reset(W, H); }
    Sound s;
    const int nb = std::max(1, in.audio_bands);
    for (int i = 0; i < Sound::N; i++) s.band[i] = std::min(255, in.audio_band(i * nb / Sound::N)) / 255.f;
    for (int i = 0; i < Sound::N; i++) (i < 6 ? s.bass : (i < 18 ? s.mid : s.treble)) += s.band[i];
    s.bass /= 6; s.mid /= 12; s.treble /= 14;
    s.level = in.audio_level ? std::min(255, in.audio_level()) / 255.f : 0;
    const uint32_t beats = in.audio_beats ? in.audio_beats() : 0;
    s.beat = beats != seen_beats;
    seen_beats = beats;
    FxCtx c;
    c.ms = in.ms; c.dt = dt; c.ticks = 0; c.rate = 0; c.level = 255; c.intensity = 100;
    c.pal = &palette_named(in.palette);
    c.neon = c.pal->n == 0;
    c.theme = theme;
    viz->render(cv, s, c, rng);
  }

  void music(Canvas &cv, const Inputs &in, float dt, bool has_ticker) {
    if (!local_mode(in).empty()) return local_music(cv, in, dt);
    const int text_y = has_ticker ? H - 18 : H - 9;
    const int chart_h = std::max(5, text_y - 2);
    const bool active = in.music_active;
    auto band = [&](int i) -> int {
      const std::string &p = in.music_bands;
      size_t s = 0; int idx = 0;
      while (s <= p.size()) {
        const size_t e = p.find(',', s);
        if (idx == i) return std::max(0, std::min(255, atoi(p.substr(s, e == std::string::npos ? std::string::npos : e - s).c_str())));
        if (e == std::string::npos) break;
        s = e + 1; idx++;
      }
      return 0;
    };
    const int level = in.music_level;
    if (!active) {
      line(cv, "WAITING FOR AUDIO", chart_h / 2 - 4, theme.secondary, 0, W, scene_epoch);
    } else if (in.music_mode == "pulse") {
      const int cx = W / 2, cy = chart_h / 2, maxr = std::max(3, std::min(W, chart_h) / 2);
      const int r0 = std::max(2, maxr * (60 + level * 40 / 255) / 100);
      for (int ring = 0; ring < 4; ring++) {
        const int rr = r0 - ring * std::max(2, maxr / 4);
        if (rr > 1) cv.circle(cx, cy, rr, hsv(180 + ring * 27 + (int) (ms / 15), 225, 230 - ring * 45));
      }
      cv.fcircle(cx, cy, std::max(1, level * 3 / 255), theme.primary);
    } else if (in.music_mode == "meter") {
      const int mw = std::max(4, W / 7), mh = std::max(1, chart_h * level / 255), mx = (W - mw) / 2;
      cv.rect(mx, 0, mw, chart_h, theme.secondary);
      for (int y = 0; y < mh; y++) cv.hline(mx + 1, mx + mw - 2, chart_h - 1 - y, mix(theme.accent, theme.critical, y * 255 / chart_h));
    } else {
      const int n = std::max(1, std::min(16, W / 4)), gap = 1, bw = std::max(1, (W - (n - 1) * gap) / n);
      const int ox = (W - (n * bw + (n - 1) * gap)) / 2;
      for (int i = 0; i < n; i++) {
        const float target = (float) band(i * 16 / n) / 255.f;
        bars[i] = target > bars[i] ? target : std::max(target, bars[i] - dt * 1.6f);
        peaks[i] = bars[i] > peaks[i] ? bars[i] : std::max(0.f, peaks[i] - dt * 0.45f);
        const int bh = std::max(1, (int) (chart_h * bars[i])), x = ox + i * (bw + gap);
        for (int y = 0; y < bh; y++) cv.hline(x, x + bw - 1, chart_h - 1 - y, mix(theme.secondary, theme.accent, y * 255 / std::max(1, chart_h - 1)));
        const int py = chart_h - 1 - (int) (chart_h * peaks[i]);
        if (peaks[i] > 0.02f) cv.hline(x, x + bw - 1, std::max(0, py), theme.primary);
      }
    }
    line(cv, in.detail.empty() ? in.title : in.detail, text_y, theme.primary, 0, W, scene_epoch);
  }

  void icon(Canvas &cv, const std::string &name, RGB c) {
    const RGB bg = theme.bg;
    if (name == "warning") { cv.ftri(12, 3, 2, 26, 22, 26, c); cv.line(12, 10, 12, 18, bg); cv.frect(11, 21, 3, 3, bg); }
    else if (name == "door") { cv.rect(4, 4, 16, 24, c); cv.line(17, 5, 17, 27, c); cv.frect(14, 16, 2, 2, c); }
    else if (name == "lock") {
      cv.rect(4, 13, 17, 14, c);
      cv.line(7, 13, 7, 9, c); cv.line(7, 9, 9, 6, c); cv.line(9, 6, 16, 6, c); cv.line(16, 6, 19, 9, c); cv.line(19, 9, 19, 13, c);
      cv.frect(11, 18, 3, 5, c);
    } else if (name == "motion") {
      cv.circle(12, 6, 3, c); cv.line(12, 9, 12, 18, c); cv.line(12, 12, 5, 16, c); cv.line(12, 12, 20, 10, c);
      cv.line(12, 18, 6, 26, c); cv.line(12, 18, 20, 25, c);
    } else if (name == "water") { cv.ftri(12, 3, 4, 19, 20, 19, c); cv.fcircle(12, 19, 8, c); cv.line(8, 20, 10, 23, bg); }
    else if (name == "fire") { cv.ftri(12, 2, 4, 23, 21, 23, c); cv.fcircle(12, 21, 8, c); cv.ftri(12, 12, 9, 25, 16, 25, bg); }
    else if (name == "success") { cv.circle(12, 16, 10, c); cv.line(6, 16, 10, 21, c); cv.line(10, 21, 19, 10, c); }
    else { cv.circle(12, 16, 10, c); cv.frect(11, 13, 3, 10, c); cv.frect(11, 8, 3, 3, c); }
  }

  void notification(Canvas &cv, const Inputs &in, bool has_ticker) {
    const RGB c = alert_color(in);
    const bool with_icon = !in.icon.empty();
    const bool thick = in.flash_border && ((in.ms - scene_epoch) / 250U) % 2U == 0U;
    cv.rect(0, 0, W, H, c);
    if (thick) cv.rect(1, 1, W - 2, H - 2, c);
    const int left = with_icon ? 25 : 2;
    // Long lines scroll across the whole interior, behind the icon.
    auto nline = [&](const std::string &text, int y) {
      if (text_width(text) <= W - 2 - left) line(cv, text, y, c, left, W - 2, scene_epoch);
      else line(cv, text, y, c, 2, W - 2, scene_epoch);
    };
    nline(in.title, 4);
    nline(in.detail, has_ticker ? 12 : H - 13);
    if (with_icon) {
      cv.frect(2, 2, 22, H - 4, theme.bg);
      // Critical alerts pulse their icon.
      const RGB ic = in.severity == "critical" ? scale(c, 150 + (int) (105 * (0.5f + 0.5f * sinturn((in.ms - scene_epoch) / 700.f)))) : c;
      icon(cv, in.icon, ic);
    }
  }
};

}  // namespace beacon
