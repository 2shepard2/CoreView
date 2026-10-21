// Music analyser for the Beacon's microphones. Pure C++17 (no ESPHome) so
// tools/preview.cpp runs the same maths on a WAV file.
//
// 512-sample Hann-windowed FFT every 256 samples (62.5 Hz at 16 kHz), summed
// into 32 mel-spaced bands (40 Hz - 7.6 kHz). Each band is in dB against its
// own slow noise floor and one shared auto-gain ceiling, so quiet rooms, loud
// rooms and bass-heavy songs all fill the 0..255 range. Bass onsets count as
// beats. Samples are discarded after each window: nothing is stored or sent.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace coreview_audio {

class Analyzer {
 public:
  static constexpr int N = 512, HOP = 256, BANDS = 32;
  static constexpr float RATE = 16000.f;

  Analyzer() {
    const float pi = 3.14159265358979f;
    for (int i = 0; i < N; i++) window_[i] = 0.5f - 0.5f * cosf(2 * pi * i / (N - 1));
    for (int i = 0; i < N / 2; i++) { cos_[i] = cosf(2 * pi * i / N); sin_[i] = -sinf(2 * pi * i / N); }
    for (int i = 0, j = 0; i < N; i++) {
      rev_[i] = (uint16_t) j;
      int bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j |= bit;
    }
    auto mel = [](float f) { return 2595.f * log10f(1.f + f / 700.f); };
    auto hz = [](float m) { return 700.f * (powf(10.f, m / 2595.f) - 1.f); };
    const float m0 = mel(40.f), m1 = mel(7600.f), bin_hz = RATE / N;
    for (int b = 0; b < BANDS; b++) {
      const float lo = hz(m0 + (m1 - m0) * b / BANDS), hi = hz(m0 + (m1 - m0) * (b + 1) / BANDS);
      lo_[b] = std::max(1, (int) lroundf(lo / bin_hz));
      hi_[b] = std::max(lo_[b] + 1, (int) lroundf(hi / bin_hz));
      // Gentle treble lift: room mics and the enclosure roll off the top.
      tilt_[b] = 2.0f * log2f(std::max(1.f, sqrtf(lo * hi) / 300.f));
      floor_[b] = -90.f;
    }
  }

  // Feed 16-bit mono samples; analyses every HOP samples.
  void push(const int16_t *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
      ring_[pos_] = s[i];
      pos_ = (pos_ + 1) % N;
      if (++fill_ >= HOP) { fill_ = 0; analyze_(); }
    }
  }

  bool active() const { return windows_ > 1; }
  uint8_t band(int i) const { return bands_[std::max(0, std::min(BANDS - 1, i))]; }
  uint8_t level() const { return level_; }
  uint32_t beats() const { return beats_; }        // increments on each detected beat
  uint8_t beat_strength() const { return beat_strength_; }
  // How loud the room is, 0 (silence at the gain floor) .. 255 (loud).
  uint8_t loudness() const { return loudness_; }

 private:
  void analyze_() {
    float mean = 0;
    for (int i = 0; i < N; i++) mean += ring_[(pos_ + i) % N];
    mean /= N;
    for (int i = 0; i < N; i++) {
      re_[rev_[i]] = (ring_[(pos_ + i) % N] - mean) * window_[i];
      im_[rev_[i]] = 0;
    }
    for (int len = 2; len <= N; len <<= 1) {
      const int half = len >> 1, step = N / len;
      for (int i = 0; i < N; i += len)
        for (int k = 0; k < half; k++) {
          const float wr = cos_[k * step], wi = sin_[k * step];
          const int a = i + k, b = a + half;
          const float tr = re_[b] * wr - im_[b] * wi, ti = re_[b] * wi + im_[b] * wr;
          re_[b] = re_[a] - tr; im_[b] = im_[a] - ti;
          re_[a] += tr; im_[a] += ti;
        }
    }
    // A full-scale sine is ~0 dB in its band.
    const float norm = 1.f / (32768.f * N / 4.f);
    float db[BANDS], peak = -120.f, total = 0;
    for (int b = 0; b < BANDS; b++) {
      float e = 0;
      for (int k = lo_[b]; k < hi_[b]; k++) e += re_[k] * re_[k] + im_[k] * im_[k];
      total += e;
      db[b] = 10.f * log10f(e * norm * norm + 1e-12f) + tilt_[b];
      peak = std::max(peak, db[b]);
    }
    const float hop_s = (float) HOP / RATE;
    // One ceiling for all bands: jumps up, sinks ~4 dB/s, never below the
    // floor that keeps a silent room dark.
    ceiling_ = std::max({peak, ceiling_ - 4.f * hop_s, kMinCeiling});
    const float range = 38.f;
    for (int b = 0; b < BANDS; b++) {
      // Noise floor: follows quiet moments down quickly, creeps up slowly.
      floor_[b] = db[b] < floor_[b] ? floor_[b] + (db[b] - floor_[b]) * 0.15f : floor_[b] + 0.6f * hop_s;
      floor_[b] = std::min(floor_[b], ceiling_ - 18.f);
      const float lo = std::max(ceiling_ - range, floor_[b] + 3.f);
      float v = (db[b] - lo) / std::max(6.f, ceiling_ - lo);
      v = std::max(0.f, std::min(1.f, v));
      raw_[b] = v;
      // Fast attack, ~0.3 s release.
      smooth_[b] = v > smooth_[b] ? smooth_[b] + (v - smooth_[b]) * 0.7f : std::max(v, smooth_[b] - 3.2f * hop_s);
      bands_[b] = (uint8_t) (smooth_[b] * 255.f + 0.5f);
    }
    const float total_db = 10.f * log10f(total * norm * norm + 1e-12f);
    level_ceiling_ = std::max({total_db, level_ceiling_ - 4.f * hop_s, kMinCeiling});
    const float lv = std::max(0.f, std::min(1.f, (total_db - (level_ceiling_ - 30.f)) / 30.f));
    level_s_ = lv > level_s_ ? lv : std::max(lv, level_s_ - 2.5f * hop_s);
    level_ = (uint8_t) (level_s_ * 255.f);
    loudness_ = (uint8_t) std::max(0.f, std::min(255.f, (level_ceiling_ - kMinCeiling) * 255.f / 40.f));

    // Beats: spectral flux of the bass bands (below ~200 Hz) against its own
    // recent average, at most ~4 a second.
    float flux = 0;
    for (int b = 0; b < 6; b++) { flux += std::max(0.f, raw_[b] - prev_raw_[b]); prev_raw_[b] = raw_[b]; }
    flux /= 6;
    since_beat_ += hop_s;
    const bool rising = flux > last_flux_;
    if (rising && flux > flux_avg_ * 1.6f + 0.06f && since_beat_ > 0.24f) {
      beats_++;
      since_beat_ = 0;
      beat_strength_ = (uint8_t) std::min(255.f, flux * 3.f * 255.f);
    }
    last_flux_ = flux;
    flux_avg_ += (flux - flux_avg_) * 0.05f;
    windows_++;
  }

  static constexpr float kMinCeiling = -62.f;
  std::array<int16_t, N> ring_{};
  std::array<float, N> window_{}, re_{}, im_{};
  std::array<float, N / 2> cos_{}, sin_{};
  std::array<uint16_t, N> rev_{};
  std::array<int, BANDS> lo_{}, hi_{};
  std::array<float, BANDS> tilt_{}, floor_{}, smooth_{}, raw_{}, prev_raw_{};
  std::array<uint8_t, BANDS> bands_{};
  int pos_ = 0, fill_ = 0;
  uint32_t windows_ = 0, beats_ = 0;
  float ceiling_ = kMinCeiling, level_ceiling_ = kMinCeiling, level_s_ = 0, since_beat_ = 0, flux_avg_ = 0, last_flux_ = 0;
  uint8_t level_ = 0, beat_strength_ = 0, loudness_ = 0;
};

}  // namespace coreview_audio
