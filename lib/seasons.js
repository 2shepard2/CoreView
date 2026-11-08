// Holiday themes: decorations drawn over the screens (render-seasons.js).
//
// One house-wide setting picks the theme: "auto" follows the calendar below,
// "off" turns themes off, or a theme id forces that theme (to preview it, keep
// it up a little longer, or show one the calendar never picks). A forced theme
// may carry "until" (a house-local YYYY-MM-DD): after that day the house goes
// back to the calendar on its own. Each screen then chooses how much of it to
// show: full, light or off (screen.seasonal, default full).
const THEMES = {
  halloween: { name: "Halloween", icon: "🎃" },
  thanksgiving: { name: "Thanksgiving", icon: "🍂" },
  christmas: { name: "Christmas", icon: "🎄" },
  newyear: { name: "New Year's", icon: "🎆" },
  // Not on the calendar: for a countdown, a party, a launch week.
  neoncoast: { name: "Neon Coast", icon: "🌴" }
};
const LEVELS = ["full", "light", "off"];

// Fourth Thursday of November.
function thanksgivingDay(year) {
  const firstWd = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return 1 + ((4 - firstWd + 7) % 7) + 21;
}

// The theme the calendar picks for a house-local date (month 0-11).
//   Halloween      Oct 15 - Oct 31
//   Thanksgiving   Nov 1 - Thanksgiving Day
//   Christmas      the day after Thanksgiving - Dec 26
//   New Year's     Dec 27 - Jan 1
function calendarTheme(year, month, day) {
  if (month === 9 && day >= 15) return "halloween";
  if (month === 10) return day <= thanksgivingDay(year) ? "thanksgiving" : "christmas";
  if (month === 11) return day <= 26 ? "christmas" : "newyear";
  if (month === 0 && day === 1) return "newyear";
  return null;
}

// House-local date parts for a UTC time (the server runs in the house's zone).
function localDate(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() };
}

function cleanMode(mode) {
  return mode === "off" || mode === "auto" || THEMES[mode] ? mode : "auto";
}
function cleanLevel(level) {
  return LEVELS.includes(level) ? level : "full";
}

// "2026-11-19" or null.
function cleanUntil(until) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof until === "string" ? until : "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? until : null;
}
function isoDay(p) { return `${p.y}-${String(p.mo + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }

// The theme in effect now for the whole house (or null).
function activeTheme(mode, ms = Date.now(), until = null) {
  mode = cleanMode(mode);
  if (mode === "off") return null;
  const p = localDate(ms);
  until = cleanUntil(until);
  if (THEMES[mode] && !(until && isoDay(p) > until)) return mode;
  return calendarTheme(p.y, p.mo, p.d);
}

// What one screen draws: { id, level } or null.
function screenTheme(mode, screen, ms = Date.now(), until = null) {
  const id = activeTheme(mode, ms, until);
  const level = cleanLevel(screen && screen.seasonal);
  return id && level !== "off" ? { id, level } : null;
}

function catalog() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, ...t }));
}

module.exports = { THEMES, LEVELS, thanksgivingDay, calendarTheme, activeTheme, screenTheme, cleanMode, cleanLevel, cleanUntil, catalog };
