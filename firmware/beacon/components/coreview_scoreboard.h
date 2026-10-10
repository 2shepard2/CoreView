#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>
#include "coreview_scoreboard_font.h"

// Pixel-for-pixel twin of render() in Studio's public/scoreboard.js (checked by
// tools/scoreboard_parity.sh). Away team on the left, home on the right; the
// wire names stay V1's (home* = left slot, guest* = right slot).
namespace coreview_scoreboard {
struct Logo {
  int size = 0;                 // 18 or 15; 0 = none (draw the initials)
  std::vector<uint32_t> px;     // size*size RGB, 0 = off
};
struct Scene {
  std::string home_label="HOME", guest_label="GUEST", home_score="--", guest_score="--";
  std::string period, time, ticker;
  bool left_on=false, right_on=false;
  uint32_t left_color=0x63D44D, right_color=0xFFAD21;
  Logo left_logo, right_logo;
  float speed=9;
  uint32_t ticker_epoch=0;
};
inline Scene &state() { static Scene scene; return scene; }
inline std::string score(const std::string &s) {
  if (s.empty() || s.size()>3 || s.find_first_not_of("0123456789")!=std::string::npos) return "--";
  const auto first=s.find_first_not_of('0');
  return first==std::string::npos ? "0" : s.substr(first);
}
// Base64 RGB grid (3 bytes per LED) -> Logo; anything malformed -> no logo.
inline Logo decode_logo(const char *b64) {
  Logo out;
  std::vector<uint8_t> bytes;
  uint32_t acc=0; int bits=0;
  for (const char *p=b64; p && *p; p++) {
    const char c=*p; int v;
    if (c>='A' && c<='Z') v=c-'A'; else if (c>='a' && c<='z') v=c-'a'+26; else if (c>='0' && c<='9') v=c-'0'+52;
    else if (c=='+') v=62; else if (c=='/') v=63; else if (c=='=') break; else return out;
    acc=(acc<<6)|v; bits+=6;
    if (bits>=8) { bits-=8; bytes.push_back((acc>>bits)&0xFF); }
    if (bytes.size()>24*24*3) return out;
  }
  int size=0;
  while ((size+1)*(size+1)*3 <= (int) bytes.size()) size++;
  if (size==0 || size*size*3 != (int) bytes.size()) return out;
  out.size=size;
  out.px.resize(size*size);
  for (int i=0;i<size*size;i++) out.px[i]=(bytes[i*3]<<16)|(bytes[i*3+1]<<8)|bytes[i*3+2];
  return out;
}

// Score digits (0-9, '-'), 11 rows; each row a bit mask, LSB = rightmost column.
// Generated from the `big`/`narrow` tables in public/scoreboard.js.
static const uint8_t BIG[11][11] = {  // 6 wide
  {0x1E,0x33,0x33,0x33,0x33,0x33,0x33,0x33,0x33,0x33,0x1E}, {0x0C,0x1C,0x3C,0x0C,0x0C,0x0C,0x0C,0x0C,0x0C,0x0C,0x3F},
  {0x1E,0x33,0x03,0x03,0x06,0x0C,0x18,0x30,0x30,0x30,0x3F}, {0x1E,0x33,0x03,0x03,0x0E,0x03,0x03,0x03,0x03,0x33,0x1E},
  {0x06,0x0E,0x1E,0x36,0x36,0x36,0x3F,0x06,0x06,0x06,0x06}, {0x3F,0x30,0x30,0x30,0x3E,0x03,0x03,0x03,0x03,0x33,0x1E},
  {0x1E,0x33,0x30,0x30,0x3E,0x33,0x33,0x33,0x33,0x33,0x1E}, {0x3F,0x03,0x03,0x06,0x06,0x0C,0x0C,0x0C,0x18,0x18,0x18},
  {0x1E,0x33,0x33,0x33,0x1E,0x33,0x33,0x33,0x33,0x33,0x1E}, {0x1E,0x33,0x33,0x33,0x33,0x1F,0x03,0x03,0x03,0x33,0x1E},
  {0x00,0x00,0x00,0x00,0x00,0x3F,0x00,0x00,0x00,0x00,0x00}};
static const uint8_t NARROW[11][11] = {  // 5 wide, for three-digit scores
  {0x0E,0x1B,0x1B,0x1B,0x1B,0x1B,0x1B,0x1B,0x1B,0x1B,0x0E}, {0x06,0x0E,0x1E,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x1F},
  {0x0E,0x1B,0x03,0x03,0x06,0x06,0x0C,0x0C,0x18,0x18,0x1F}, {0x0E,0x1B,0x03,0x03,0x06,0x03,0x03,0x03,0x03,0x1B,0x0E},
  {0x03,0x07,0x0F,0x1B,0x1B,0x1F,0x03,0x03,0x03,0x03,0x03}, {0x1F,0x18,0x18,0x18,0x1E,0x03,0x03,0x03,0x03,0x1B,0x0E},
  {0x0E,0x1B,0x18,0x18,0x1E,0x1B,0x1B,0x1B,0x1B,0x1B,0x0E}, {0x1F,0x03,0x03,0x06,0x06,0x06,0x0C,0x0C,0x0C,0x0C,0x0C},
  {0x0E,0x1B,0x1B,0x1B,0x0E,0x1B,0x1B,0x1B,0x1B,0x1B,0x0E}, {0x0E,0x1B,0x1B,0x1B,0x1B,0x0F,0x03,0x03,0x03,0x1B,0x0E},
  {0x00,0x00,0x00,0x00,0x00,0x1F,0x00,0x00,0x00,0x00,0x00}};

// Rows 0-22 game, 23 divider, 24-31 ticker. Logos at the edges (initials over
// the score when there is none), scores inside them, period on top, clock in the middle.
// All writes pass through put(); no heap allocation per frame.
template<class Pixel> void render(const Scene &s, uint32_t elapsed_ms, Pixel pixel) {
  const uint32_t RED=0xFF361F, AMBER=0xFFAD21;
  auto put=[&](int x,int y,uint32_t c,int lo=0,int hi=32) {
    if(x>=0 && x<96 && y>=lo && y<hi) pixel(x,y,c);
  };
  for(int y=0;y<32;y++) for(int x=0;x<96;x++) put(x,y,0x050605);
  // 5x7 text; ':' is two pixels wide so "12:34" is 25 px.
  auto width=[](const std::string &v) { int n=0; for(char ch: v) n += ch==':' ? 2 : 6; return std::max(0,n-1); };
  auto text=[&](const std::string &v,int x,int y,uint32_t c) {
    for(char ch: v) {
      if(ch==':') { put(x,y+2,c); put(x,y+5,c); x+=2; continue; }
      const auto *columns=glyph(ch);
      for(int col=0;col<5;col++) for(int row=0;row<7;row++) if(columns[col] & (1 << (6-row))) put(x+col,y+row,c);
      x+=6;
    }
  };
  // Floor division like JS Math.floor, so odd widths centre identically.
  auto center=[&](const std::string &v,int cx,int y,uint32_t c) { const int w=width(v); text(v,cx-(w>>1),y,c); };
  const std::string hs=score(s.home_score), gs=score(s.guest_score);
  const bool wide=hs.size()>2 || gs.size()>2;
  const int size=wide ? 15 : 18, gw=wide ? 5 : 6;
  const auto &digits=wide ? NARROW : BIG;
  auto score_w=[&](const std::string &v) { return (int) v.size()*(gw+1)-1; };
  const int ly=(23-size)/2;
  // Logo at the edge and the score inside it. Without a logo the initials go on
  // top and the score is centred under them, in the same footprint.
  auto side=[&](const Logo &logo,const std::string &label,const std::string &sc,bool left) -> int {
    const int area=size+2+score_w(sc), a0=left ? 1 : 95-area;
    if(logo.size==size && (int) logo.px.size()==size*size) {
      const int x0=left ? 1 : 95-size;
      for(int i=0;i<size*size;i++) if(logo.px[i]) put(x0+i%size,ly+i/size,logo.px[i]);
      return left ? 1+size+2 : 95-size-2-score_w(sc);
    }
    const int cx=a0+area/2;
    center(label.substr(0,4),cx,0,AMBER);
    return cx-score_w(sc)/2;
  };
  const int lx=side(s.left_logo,s.home_label,hs,true), rx=side(s.right_logo,s.guest_label,gs,false);
  const bool pre=s.period=="PRE";
  auto number=[&](const std::string &v,int x) {
    for(char ch: v) {
      const int g=ch>='0' && ch<='9' ? ch-'0' : 10;
      for(int ry=0;ry<11;ry++) for(int c=0;c<gw;c++) if(digits[g][ry] & (1 << (gw-1-c))) put(x+c,8+ry,RED);
      x+=gw+1;
    }
  };
  if(!pre) { number(hs,lx); number(gs,rx); }
  auto dot=[&](int cx,uint32_t c) { for(int d=0;d<4;d++) put(cx+d%2,20+d/2,c); };
  if(!pre && s.left_on) dot(lx+score_w(hs)/2-1,s.left_color);
  if(!pre && s.right_on) dot(rx+score_w(gs)/2-1,s.right_color);
  center(s.period.substr(0,5),48,0,AMBER);
  center(s.time.substr(0,6),48,11,RED);
  for(int x=0;x<96;x++) put(x,23,0x372914);
  // Ticker lane (the engine redraws it with its own lowercase font on the device).
  if(!s.ticker.empty()) {
    const int length=std::min<int>(s.ticker.size(),512);
    const int span=std::max(96,length*6-1)+48;
    const int offset=static_cast<uint64_t>(elapsed_ms*static_cast<double>(s.speed)/1000)%span;
    for(int pass=0;pass<2;pass++) {
      int x=pass ? span-offset : -offset;
      for(int i=0;i<length;i++,x+=6) {
        if(x+5<=0 || x>=96) continue;
        const auto *columns=glyph(s.ticker[i]);
        for(int col=0;col<5;col++) for(int row=0;row<7;row++) if(columns[col] & (1 << (6-row))) put(x+col,25+row,AMBER,25,32);
      }
    }
  }
}
}  // namespace coreview_scoreboard
