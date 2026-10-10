// Renders one scoreboard scene (key=value lines on stdin) with the firmware's
// renderer and writes 96x32 RGB to stdout. Driven by scoreboard_parity.js.
#include <cstdio>
#include <iostream>
#include <string>
#include "coreview_scoreboard.h"

int main() {
  coreview_scoreboard::Scene s;
  std::string line;
  uint32_t ms = 0;
  while (std::getline(std::cin, line)) {
    const auto eq = line.find('=');
    if (eq == std::string::npos) continue;
    const std::string k = line.substr(0, eq), v = line.substr(eq + 1);
    if (k == "homeLabel") s.home_label = v; else if (k == "guestLabel") s.guest_label = v;
    else if (k == "homeScore") s.home_score = coreview_scoreboard::score(v); else if (k == "guestScore") s.guest_score = coreview_scoreboard::score(v);
    else if (k == "period") s.period = v; else if (k == "remainingTime") s.time = v; else if (k == "ticker") s.ticker = v;
    else if (k == "leftOn") s.left_on = v == "true"; else if (k == "rightOn") s.right_on = v == "true";
    else if (k == "leftColor") s.left_color = std::stoul(v.substr(1), nullptr, 16); else if (k == "rightColor") s.right_color = std::stoul(v.substr(1), nullptr, 16);
    else if (k == "leftLogo") s.left_logo = coreview_scoreboard::decode_logo(v.c_str());
    else if (k == "rightLogo") s.right_logo = coreview_scoreboard::decode_logo(v.c_str());
    else if (k == "tickerSpeed") s.speed = std::stof(v); else if (k == "ms") ms = std::stoul(v);
  }
  static unsigned char frame[96 * 32 * 3];
  coreview_scoreboard::render(s, ms, [&](int x, int y, uint32_t c) {
    unsigned char *p = frame + (y * 96 + x) * 3; p[0] = c >> 16; p[1] = (c >> 8) & 255; p[2] = c & 255; });
  fwrite(frame, 1, sizeof frame, stdout);
  return 0;
}
