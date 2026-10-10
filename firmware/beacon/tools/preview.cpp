// Desktop preview: renders scripted scenarios with the firmware's engine and
// writes raw RGB frames (96x32x3 bytes each) for tools/preview.py.
// Build: g++ -std=c++17 -O2 -fno-rtti -Icomponents tools/preview.cpp -o /tmp/beacon-preview
#include <cstdio>
#include <cstdlib>
#include <string>
#include "beacon_engine.h"

struct Scn : beacon::Inputs { int hour_base = 0, minute_base = 0; };

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
  } else if (sc == "waterfall") {  // local microphone, Audio Mode Waterfall
    Scn in = clock_base(); in.scene = "music"; in.title = "VIBES"; in.music_mode = "local_waterfall";
    in.audio_active = true;
    int frame = 0;
    // Room-mic-like levels: strong bass, weak treble, a beat every ~0.5 s.
    in.audio_band = [&frame](int b) {
      const float beat = (frame % 18) < 4 ? 1.f : 0.35f;
      const float melody = 0.5f + 0.5f * sinf(frame * 0.09f + b * 0.8f);
      return (int) ((b < 4 ? 40 * beat : 14 * melody) * (1.f - b / 22.f));
    };
    in.audio_level = [&frame]() { return (frame % 18) < 4 ? 40 : 12; };
    for (; frame < 6 * FPS; frame++) w.run(in, 1.f / FPS);
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
