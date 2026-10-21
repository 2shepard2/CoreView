#pragma once

#include "esphome.h"
#include "coreview_audio_dsp.h"

#include <cstdint>
#include <vector>

// The Beacon's microphones -> coreview_audio::Analyzer (32 bands, level,
// beats). Samples are analysed in place and discarded: this is not a recorder
// or an audio transport.
class CoreViewAudioReactive {
 public:
  explicit CoreViewAudioReactive(esphome::microphone::Microphone *microphone) : microphone_(microphone) {}

  void setup() {
    this->microphone_->add_data_callback([this](const std::vector<uint8_t> &data) { this->consume_(data); });
    this->microphone_->start();
  }

  bool is_active() const { return this->analyzer_.active(); }
  uint8_t level() const { return this->analyzer_.level(); }
  uint8_t band(int index) const { return this->analyzer_.band(index); }
  int band_count() const { return coreview_audio::Analyzer::BANDS; }
  uint32_t beats() const { return this->analyzer_.beats(); }

 protected:
  void consume_(const std::vector<uint8_t> &data) {
    int16_t chunk[128];
    size_t n = 0;
    for (size_t offset = 0; offset + 1 < data.size(); offset += 2) {
      chunk[n++] = static_cast<int16_t>(static_cast<uint16_t>(data[offset]) | (static_cast<uint16_t>(data[offset + 1]) << 8));
      if (n == 128) { this->analyzer_.push(chunk, n); n = 0; }
    }
    if (n) this->analyzer_.push(chunk, n);
    const uint32_t now = millis();
    if (now - this->last_log_ms_ >= 2000U) {
      this->last_log_ms_ = now;
      char bars[33];
      for (int b = 0; b < 32; b++) bars[b] = " .:-=+*#%@"[this->analyzer_.band(b) * 9 / 255];
      bars[32] = 0;
      ESP_LOGD("coreview.audio", "level=%u loud=%u beats=%u |%s|", this->analyzer_.level(), this->analyzer_.loudness(),
               (unsigned) this->analyzer_.beats(), bars);
    }
  }

  esphome::microphone::Microphone *microphone_;
  coreview_audio::Analyzer analyzer_;
  uint32_t last_log_ms_{0};
};
