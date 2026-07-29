#pragma once

#include "esphome.h"

#include <array>
#include <cmath>
#include <cstdint>

// A deliberately small local audio analyzer for the Matrix Beacon. It takes
// 16-bit microphone samples, derives sixteen visual bands, and discards the
// samples immediately. This is not a recorder or an audio transport.
class CoreViewAudioReactive {
 public:
  explicit CoreViewAudioReactive(esphome::microphone::Microphone *microphone) : microphone_(microphone) {}

  void setup() {
    this->microphone_->add_data_callback([this](const std::vector<uint8_t> &data) { this->consume_(data); });
    this->microphone_->start();
  }

  bool is_active() const { return this->has_samples_; }
  uint8_t level() const { return this->level_; }
  uint8_t band(uint8_t index) const { return this->bands_[std::min<uint8_t>(index, this->bands_.size() - 1)]; }

 protected:
  static constexpr size_t WINDOW_SIZE = 256;
  static constexpr float SAMPLE_RATE = 16000.0f;
  static constexpr float PI = 3.14159265358979323846f;
  static constexpr std::array<float, 16> CENTERS = {
      70.0f, 100.0f, 150.0f, 220.0f, 320.0f, 450.0f, 640.0f, 900.0f,
      1250.0f, 1750.0f, 2400.0f, 3200.0f, 4200.0f, 5200.0f, 6200.0f, 7000.0f};

  void consume_(const std::vector<uint8_t> &data) {
    for (size_t offset = 0; offset + 1 < data.size(); offset += 2) {
      const int16_t sample = static_cast<int16_t>(static_cast<uint16_t>(data[offset]) |
                                                   (static_cast<uint16_t>(data[offset + 1]) << 8));
      this->samples_[this->sample_count_++] = sample;
      if (this->sample_count_ == WINDOW_SIZE) {
        this->analyze_();
        this->sample_count_ = 0;
      }
    }
  }

  void analyze_() {
    float rms_sum = 0.0f;
    for (int16_t sample : this->samples_) {
      const float normalized = static_cast<float>(sample) / 32768.0f;
      rms_sum += normalized * normalized;
    }
    const float rms = std::sqrt(rms_sum / WINDOW_SIZE);
    this->peak_ = std::max(rms, this->peak_ * 0.985f);
    const float divisor = std::max(0.015f, this->peak_);
    const float normalized_level = std::min(1.0f, std::max(0.0f, (rms - 0.008f) / divisor));
    const uint8_t next_level = static_cast<uint8_t>(normalized_level * 255.0f);
    this->level_ = static_cast<uint8_t>((this->level_ * 3U + next_level) / 4U);

    for (size_t band = 0; band < CENTERS.size(); band++) {
      const float coefficient = 2.0f * std::cos(2.0f * PI * CENTERS[band] / SAMPLE_RATE);
      float q0 = 0.0f;
      float q1 = 0.0f;
      float q2 = 0.0f;
      for (int16_t sample : this->samples_) {
        q0 = static_cast<float>(sample) + coefficient * q1 - q2;
        q2 = q1;
        q1 = q0;
      }
      const float magnitude = std::sqrt(std::max(0.0f, q1 * q1 + q2 * q2 - coefficient * q1 * q2)) / WINDOW_SIZE;
      // Room microphones and the Matrix enclosure naturally roll off higher
      // frequencies. Do not hard-gate individual bands: quiet treble should
      // remain visible while music is playing, rather than vanishing outright.
      const float compensated = magnitude * (1.0f + static_cast<float>(band) * 0.85f);
      const float band_value = std::min(1.0f, compensated / 1450.0f);
      const uint8_t next_band = static_cast<uint8_t>(band_value * 255.0f);
      this->bands_[band] = static_cast<uint8_t>((this->bands_[band] * 2U + next_band) / 3U);
    }
    this->has_samples_ = true;
    const uint32_t now = millis();
    if (now - this->last_log_ms_ >= 1000U) {
      this->last_log_ms_ = now;
      ESP_LOGD("coreview.audio", "rms=%.4f level=%u bands=%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u", rms, this->level_,
               this->bands_[0], this->bands_[1], this->bands_[2], this->bands_[3], this->bands_[4],
               this->bands_[5], this->bands_[6], this->bands_[7], this->bands_[8], this->bands_[9],
               this->bands_[10], this->bands_[11], this->bands_[12], this->bands_[13], this->bands_[14],
               this->bands_[15]);
    }
  }

  esphome::microphone::Microphone *microphone_;
  std::array<int16_t, WINDOW_SIZE> samples_{};
  std::array<uint8_t, 16> bands_{};
  size_t sample_count_{0};
  float peak_{0.015f};
  uint8_t level_{0};
  bool has_samples_{false};
  uint32_t last_log_ms_{0};
};
