// Grandma's whiteboard as three linked Studio views (1024x768, her frame):
// photos (idle) -> tap -> calendar board -> tile -> drawing board.
// build({ album, ids: { idle, board, draw } }) returns { idle, board, draw }
// drafts. Used by scripts/smoke-whiteboard.mjs and to set up the real views.
const X = (px) => Math.round(px / 1024 * 10000) / 100, Y = (px) => Math.round(px / 768 * 10000) / 100;
const box = (l, t, w, h) => ({ x: X(l), y: Y(t), w: X(w), h: Y(h) });
const plain = { textColor: "", shadow: false, bg: "#000000", bgOpacity: 0, radius: 0, padding: 0 };
const MARKERS = [
  { entity: "calendar.grandma", name: "Me", color: "#6a3fa6", birthdays: false },
  { entity: "calendar.family", name: "Family", color: "#1d8a4b", birthdays: false },
  { entity: "calendar.birthdays", name: "Birthdays", color: "#c8282b", birthdays: true }
];

function build({ album, ids, markers = MARKERS, board = "whiteboard" }) {
  const base = { aspect: { w: 1024, h: 768 }, background: "#000000", textColor: "#ffffff", font: "nunito", accentFont: "" };
  const idle = { ...base, touchView: ids.board, idleView: "", idleSeconds: 60, widgets: [
    { id: "wb-photos", type: "photos", ...box(0, 0, 1024, 768), props: { albumId: album, interval: 9, order: "shuffle", fit: "cover", caption: "corner", captionLabel: "Grandma's Photos", captionSize: 2.34, fridgeBoard: board, frame: "none", shade: true, tapView: "" } },
    { id: "wb-hint", type: "text", ...box(357, 26, 310, 40), props: { ...plain, text: "Tap anywhere for your calendar", size: 2.34, weight: "700", align: "center", breathe: true, bg: "#000000", bgOpacity: 35, radius: 2.6, padding: 1.04 } },
    { id: "wb-wx", type: "weather", ...box(790, 24, 200, 80), props: { ...plain, entity: "weather.forecast_home", show: "temp_text", size: 5.73, align: "right", shadow: true } },
    { id: "wb-clock", type: "clock", ...box(34, 570, 560, 164), props: { ...plain, format: "12", showAmPm: true, showSeconds: false, showDate: true, dateStyle: "long", look: "bold", size: 14.58, align: "left", shadow: true } },
    { id: "wb-sticky", type: "sticky", ...box(650, 528, 340, 200), props: { calendars: markers, title: "Today", emptyText: "Nothing planned. Enjoy it!", birthdayDays: 10, size: 2.08 } }
  ] };
  const boardView = { ...base, background: "#9aa1a9", touchView: "", idleView: ids.idle, idleSeconds: 60, widgets: [
    { id: "wb-frame", type: "panel", ...box(0, 0, 1024, 768), props: { look: "whiteboard", title: "", note: "", size: 2.08, ...plain, outline: false } },
    { id: "wb-cal", type: "wbcal", ...box(28, 16, 766, 724), props: { calendars: markers, allowAdd: true, allowErase: true, quickPicks: "Doctor, Hair, Church, Lunch with…, Call…, Birthday, Pick up meds, Grandkids over", size: 2.08 } },
    { id: "wb-kids", type: "button", ...box(600, 28, 244, 51), props: { ...plain, action: "kids", entity: "", view: "", icon: "", label: "✏️ Grandkids are here", labelOn: "🔒 Grandma", look: "pill-light", ring: false, confirm: false, size: 2.08, outline: false } },
    { id: "wb-photosbtn", type: "button", ...box(856, 28, 136, 52), props: { ...plain, action: "view", entity: "", view: ids.idle, icon: "", label: "Photos", labelOn: "", look: "pill", ring: true, confirm: false, size: 2.08, outline: false } },
    { id: "wb-polaroid", type: "photos", ...box(806, 110, 190, 158), props: { albumId: album, interval: 9, order: "shuffle", fit: "cover", caption: "none", captionLabel: "", captionSize: 2.34, fridgeBoard: "", frame: "polaroid", shade: false, tapView: ids.idle } },
    { id: "wb-tile", type: "drawtile", ...box(806, 284, 190, 456), props: { board, title: "Whiteboard", view: ids.draw, size: 2.08 } }
  ] };
  const draw = { ...base, background: "#9aa1a9", touchView: "", idleView: ids.idle, idleSeconds: 180, widgets: [
    { id: "wb-draw", type: "drawing", ...box(0, 0, 1024, 768), props: { board, notesTitle: "Grandma's notes", playTitle: "Play", notesColors: markers.map((m) => m.color).concat("#22262b").join(", "), allowFridge: true, backView: ids.board, backLabel: "‹ Calendar", size: 2.08 } }
  ] };
  return { idle, board: boardView, draw };
}

module.exports = { build, MARKERS };
