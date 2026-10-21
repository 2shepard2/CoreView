// Desktop preview: renders scripted scenarios with the firmware's engine and
// writes raw RGB frames (96x32x3 bytes each) for tools/preview.py.
// Build: g++ -std=c++17 -O2 -fno-rtti -Icomponents tools/preview.cpp -o /tmp/beacon-preview
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "beacon_engine.h"
#include "coreview_audio_dsp.h"

struct Scn : beacon::Inputs { int hour_base = 0, minute_base = 0; int64_t epoch_base = 0; };

static const int W = 96, H = 32, FPS = 37;

struct Writer {
  FILE *f;
  beacon::Engine eng;
  uint32_t ms = 100000;
  void run(Scn in, float seconds, int base_sec = 0) {
    const int frames = (int) (seconds * FPS);
    for (int i = 0; i < frames; i++) {
      ms += 1000 / FPS;
      in.ms = ms;
      if (in.booting) in.boot_elapsed = (uint32_t) (i * 1000 / FPS);
      const int total = base_sec + i / FPS;
      in.second = total % 60;
      in.minute = (in.minute_base + total / 60) % 60;
      in.hour = (in.hour_base + (in.minute_base + total / 60) / 60) % 24;
      if (in.epoch_base) in.epoch = in.epoch_base + total;
      eng.render(in, W, H);
      for (auto &p : eng.frame.px) fwrite(&p, 3, 1, f);
    }
  }
};

static Scn clock_base() {
  Scn in;
  in.time_valid = true;
  in.scene = "clock";
  in.title = "Out:72\xC2\xB0 In:70\xC2\xB0";
  in.primary = "#ffd9a0"; in.secondary = "#3a8dff"; in.accent = "#ffb000";
  return in;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: preview <scenario> <out.raw>\n"); return 2; }
  const std::string sc = argv[1];
  Writer w{fopen(argv[2], "wb")};
  if (!w.f) return 1;
  if (sc == "boot") {
    Scn in = clock_base(); in.booting = true;
    w.run(in, 3.5f);
    in.booting = false; in.hour_base = 6; in.minute_base = 59;
    w.run(in, 2.5f, 58);
  } else if (sc == "clock") {
    Scn in = clock_base(); in.hour_base = 9; in.minute_base = 59;
    w.run(in, 4.f, 57);  // 9:59 -> 10:00 (layout change)
    in.hour_base = 10; in.minute_base = 14;
    w.run(in, 5.f, 56);  // 10:14 -> 10:15 morph
  } else if (sc == "alert") {
    Scn in = clock_base(); in.hour_base = 18; in.minute_base = 42;
    w.run(in, 1.5f, 10);
    Scn a = in; a.scene = "notification"; a.title = "Front Door"; a.detail = "Opened while armed"; a.icon = "door";
    a.severity = "critical"; a.flash_border = true;
    w.run(a, 4.f, 12);
    w.run(in, 2.f, 16);
    Scn n = in; n.scene = "notification"; n.title = "Laundry"; n.detail = "The dryer finished its cycle - time to fold"; n.icon = "success";
    w.run(n, 6.f, 18);
    w.run(in, 1.5f, 24);
  } else if (sc == "ticker") {
    Scn in = clock_base(); in.hour_base = 15; in.minute_base = 5;
    in.ticker = "Grocery pickup at 5:30 - don't forget the milk!";
    w.run(in, 9.f, 0);
  } else if (sc == "theme") {
    Scn in = clock_base(); in.hour_base = 20; in.minute_base = 29;
    w.run(in, 2.f, 58);
    in.primary = "#ff5a3c"; in.secondary = "#7a2a10"; in.background = "#000000";
    w.run(in, 3.f, 0);
  } else if (sc == "music") {
    Scn in = clock_base(); in.scene = "music"; in.title = "Now playing"; in.detail = "Fleetwood Mac - Dreams";
    in.music_active = true; in.music_mode = "spectrum";
    for (int t = 0; t < 6 * FPS; t++) {
      std::string b;
      for (int i = 0; i < 16; i++) {
        const float v = 0.5f + 0.5f * sinf(t * 0.21f + i * 0.7f) * cosf(t * 0.05f + i);
        b += (i ? "," : "") + std::to_string((int) (std::max(0.f, v) * (255 - i * 9)));
      }
      in.music_bands = b; in.music_level = 160;
      w.run(in, 1.f / FPS);
    }
  } else if (sc.rfind("local:", 0) == 0) {  // local:<audio mode>:<16 kHz mono s16le file>[:palette[:seconds]]
    // Runs real audio through the firmware's analyser (coreview_audio_dsp.h).
    std::vector<std::string> part;
    for (size_t s0 = 0, e; ; s0 = e + 1) { e = sc.find(':', s0); part.push_back(sc.substr(s0, e == std::string::npos ? e : e - s0)); if (e == std::string::npos) break; }
    if (part.size() < 3) { fprintf(stderr, "local:<mode>:<file.raw>[:palette[:seconds]]\n"); return 2; }
    FILE *af = fopen(part[2].c_str(), "rb");
    if (!af) { perror(part[2].c_str()); return 1; }
    static coreview_audio::Analyzer an;
    Scn in = clock_base(); in.scene = "music"; in.music_mode = "local_" + part[1];
    in.palette = part.size() > 3 && !part[3].empty() ? part[3] : "neon";
    in.audio_active = true; in.audio_bands = coreview_audio::Analyzer::BANDS;
    in.audio_band = [](int b) { return (int) an.band(b); };
    in.audio_level = []() { return (int) an.level(); };
    in.audio_beats = []() { return an.beats(); };
    const float seconds = part.size() > 4 ? (float) atof(part[4].c_str()) : 12.f;
    std::vector<int16_t> buf(16000 / FPS);
    for (int f = 0; f < (int) (seconds * FPS) && fread(buf.data(), 2, buf.size(), af) == buf.size(); f++) {
      an.push(buf.data(), buf.size());
      w.run(in, 1.f / FPS);
    }
    fclose(af);
  } else if (sc == "countdown") {  // kitchen timer: running, paused, last seconds, done
    Scn in = clock_base(); in.hour_base = 18; in.minute_base = 5; in.epoch_base = 1792000000;
    w.run(in, 1.f, 0);
    Scn c = in; c.scene = "countdown"; c.title = "KITCHEN TIMER"; c.count_state = "running";
    c.count_ends = in.epoch_base + 1 + 723; c.count_duration = 1200;
    w.run(c, 4.f, 1);
    Scn p = c; p.count_state = "paused"; p.count_remaining = 719;
    w.run(p, 2.5f, 5);
    Scn r = c; r.count_ends = in.epoch_base + 8 + 3;
    w.run(r, 5.f, 8);
    Scn d = c; d.count_state = "done";
    w.run(d, 3.f, 13);
  } else if (sc == "scoreboard") {
    auto &s = coreview_scoreboard::state();
    s.home_label = "ASU"; s.guest_label = "UTAH"; s.home_score = "24"; s.guest_score = "17"; s.period = "Q3"; s.time = "4:12";
    s.ticker = "ASU 1st & 10 at UTAH 34"; s.left_on = true;
    Scn in = clock_base(); in.scene = "scoreboard";
    w.run(in, 4.f);
  } else {  // effect:<name>[:palette]
    Scn in = clock_base(); in.scene = "effect";
    std::string name = sc.rfind("effect:", 0) == 0 ? sc.substr(7) : sc, palette = "neon";
    const size_t c = name.find(':');
    if (c != std::string::npos) { palette = name.substr(c + 1); name = name.substr(0, c); }
    in.effect = name; in.palette = palette; in.speed = 40; in.intensity = 80; in.title = "COREVIEW";
    in.hour_base = 7; in.minute_base = 41;
    w.run(in, name == "pong" ? 75.f : 6.f, 20);
  }
  fclose(w.f);
  return 0;
}
