// The widget catalog: one table that the editor builds its forms from and the
// server validates every saved view against.
//
// Geometry: x, y, w, h are percentages of the screen (0-100). Text sizes are
// percentages of the screen height, so a view looks the same on any display
// with the same shape.
//
// minChrome is the oldest Chromium the widget's display code runs on. The
// shared renderer is ES5, so everything here runs on the bedroom frame
// (Chrome 44). A future widget that needs a newer engine (video, maps) sets a
// higher number and Studio greys it out for older displays.

const COLOR = /^#[0-9a-fA-F]{6}$/;
const BOARD = /^[a-z0-9-]{1,32}$/;
const ALIGN = { kind: "select", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]] };

const STYLE_FIELDS = [
  { key: "textColor", label: "Text colour", kind: "color", default: "" },
  { key: "shadow", label: "Text shadow (for text over photos)", kind: "toggle", default: true },
  { key: "bg", label: "Box colour", kind: "color", default: "#000000" },
  { key: "bgOpacity", label: "Box opacity %", kind: "number", min: 0, max: 100, step: 5, default: 0 },
  { key: "radius", label: "Corner rounding", kind: "number", min: 0, max: 10, step: 0.5, default: 1.5 },
  { key: "padding", label: "Padding", kind: "number", min: 0, max: 10, step: 0.5, default: 1 }
];

// Household widgets (sizes follow the original house board app: at size 1.04
// on a 1080x1920 screen, 1em is the board's 20px). Cards default to the
// board's see-through panel; small tiles to its lighter inset tile.
const withDefaults = (fields, d) => fields.map((f) => ({ ...f, default: d[f.key] ?? f.default }));
const OUTLINE = { key: "outline", label: "Thin outline", kind: "toggle", default: true };
const CARD_FIELDS = withDefaults([...STYLE_FIELDS, OUTLINE], { shadow: false, bg: "#121622", bgOpacity: 42, radius: 1.77, padding: 1.5 });
const TILE_FIELDS = withDefaults([...STYLE_FIELDS, OUTLINE], { shadow: false, bg: "#ffffff", bgOpacity: 6, radius: 1.25, padding: 0.6, outline: false });
const PEOPLE_ROW = [
  { key: "entity", label: "Person", kind: "entity", domain: "person", default: "" },
  { key: "name", label: "Name (blank = HA name)", kind: "text", default: "" },
  { key: "color", label: "Colour", kind: "color", default: "#4f8cff" }
];
const SIZE = (d = 1.04) => ({ key: "size", label: "Text size", kind: "number", min: 0.4, max: 8, step: 0.02, default: d });
const WIDGETS = {
  photos: {
    name: "Photo slideshow", icon: "🖼", minChrome: 44,
    description: "Photos from an Immich album, with a gentle fade.",
    size: { w: 100, h: 100 },
    fields: [
      { key: "albumId", label: "Album", kind: "album", default: "" },
      { key: "interval", label: "Seconds per photo", kind: "number", min: 5, max: 3600, step: 5, default: 20 },
      { key: "order", label: "Order", kind: "select", options: [["shuffle", "Shuffle"], ["newest", "Newest first"], ["oldest", "Oldest first"]], default: "shuffle" },
      { key: "fit", label: "Fit", kind: "select", options: [["cover", "Fill the box (crop)"], ["contain", "Whole photo (bars)"], ["smart", "Fill landscape, whole portrait"]], default: "smart" },
      { key: "caption", label: "Caption", kind: "select", options: [["none", "None"], ["date", "Date"], ["date_place", "Date and place"], ["corner", "Place or month, top left, with a label"]], default: "none" },
      { key: "captionLabel", label: "Caption label (e.g. Grandma's Photos)", kind: "text", default: "" },
      { key: "captionSize", label: "Caption size", kind: "number", min: 1, max: 10, step: 0.5, default: 2.6 },
      { key: "fridgeBoard", label: "Mix in fridge drawings from drawing board (its name; blank = none)", kind: "text", default: "" },
      { key: "frame", label: "Frame", kind: "select", options: [["none", "None"], ["polaroid", "Polaroid, taped on"]], default: "none" },
      { key: "shade", label: "Darken the top and bottom (for text on top)", kind: "toggle", default: false },
      { key: "tapView", label: "Tapping it opens view", kind: "view", default: "" }
    ]
  },
  clock: {
    name: "Clock", icon: "🕒", minChrome: 44,
    description: "Time, with the date if you like.",
    size: { w: 30, h: 18 },
    fields: [
      { key: "format", label: "Format", kind: "select", options: [["12", "12-hour"], ["24", "24-hour"]], default: "12" },
      { key: "showAmPm", label: "Show AM/PM", kind: "toggle", default: true },
      { key: "showSeconds", label: "Show seconds", kind: "toggle", default: false },
      { key: "showDate", label: "Show date", kind: "toggle", default: true },
      { key: "dateStyle", label: "Date style", kind: "select", options: [["long", "Monday, October 5"], ["short", "Mon, Oct 5"]], default: "long" },
      { key: "look", label: "Look", kind: "select", options: [["plain", "Plain"], ["elegant", "Elegant (thin headline font, small AM/PM)"], ["bold", "Bold (heavy numbers, small AM/PM)"]], default: "plain" },
      { key: "size", label: "Size", kind: "number", min: 2, max: 60, step: 0.5, default: 11 },
      { key: "align", label: "Align", ...ALIGN, default: "left" },
      ...STYLE_FIELDS
    ]
  },
  text: {
    name: "Text", icon: "🔤", minChrome: 44,
    description: "A title, a message, anything you type.",
    size: { w: 40, h: 12 },
    fields: [
      { key: "text", label: "Text", kind: "textarea", default: "Hello" },
      { key: "size", label: "Size", kind: "number", min: 1, max: 60, step: 0.5, default: 6 },
      { key: "weight", label: "Weight", kind: "select", options: [["400", "Regular"], ["600", "Semi-bold"], ["700", "Bold"]], default: "600" },
      { key: "breathe", label: "Gently pulse (for a hint)", kind: "toggle", default: false },
      { key: "align", label: "Align", ...ALIGN, default: "left" },
      ...STYLE_FIELDS
    ]
  },
  weather: {
    name: "Weather", icon: "⛅", minChrome: 44,
    description: "Current temperature and conditions from Home Assistant.",
    size: { w: 22, h: 14 },
    fields: [
      { key: "entity", label: "Weather entity", kind: "entity", domain: "weather", default: "" },
      { key: "show", label: "Show", kind: "select", options: [["temp_condition", "Temperature and conditions"], ["temp_text", "Temperature and conditions, no icon"], ["temp", "Temperature only"]], default: "temp_condition" },
      { key: "size", label: "Size", kind: "number", min: 2, max: 40, step: 0.5, default: 8 },
      { key: "align", label: "Align", ...ALIGN, default: "right" },
      ...STYLE_FIELDS
    ]
  },
  entity: {
    name: "Home Assistant tile", icon: "🏠", minChrome: 44,
    description: "Any Home Assistant sensor or state: doors, laundry, temperatures.",
    size: { w: 24, h: 14 },
    fields: [
      { key: "entity", label: "Entity", kind: "entity", default: "" },
      { key: "label", label: "Label (blank = HA name)", kind: "text", default: "" },
      { key: "showUnit", label: "Show unit", kind: "toggle", default: true },
      { key: "size", label: "Size", kind: "number", min: 1, max: 40, step: 0.5, default: 5 },
      { key: "align", label: "Align", ...ALIGN, default: "left" },
      { key: "attribute", label: "Show an attribute instead (e.g. current_temperature)", kind: "text", default: "" },
      { key: "words", label: "On / off words", kind: "select", options: [["auto", "Automatic"], ["door", "Open / Closed"], ["lock", "Unlocked / Locked"], ["presence", "Home / Away"], ["onoff", "On / Off"]], default: "auto" },
      { key: "staleHours", label: "Treat as old after hours (0 = never)", kind: "number", min: 0, max: 72, step: 1, default: 0 },
      { key: "staleText", label: "Show this when old", kind: "text", default: "" },
      ...STYLE_FIELDS.map((f) => (f.key === "bgOpacity" ? { ...f, default: 45 } : f))
    ]
  },
  calendar: {
    name: "Calendar", icon: "📅", minChrome: 44, interactive: true,
    description: "Today and tomorrow, or a rolling month. Can add and erase events.",
    size: { w: 45, h: 40 },
    fields: [
      { key: "calendars", label: "Calendars", kind: "rows", max: 8, fields: [
        { key: "entity", label: "Calendar", kind: "entity", domain: "calendar", default: "" },
        { key: "name", label: "Name", kind: "text", default: "" },
        { key: "color", label: "Colour", kind: "color", default: "#7fe0a1" },
        { key: "birthdays", label: "Birthdays (shows the next one)", kind: "toggle", default: false }
      ], default: [] },
      { key: "layout", label: "Layout", kind: "select", options: [["agenda", "Today and tomorrow"], ["month", "Rolling weeks"]], default: "agenda" },
      { key: "weeks", label: "Weeks (rolling weeks)", kind: "number", min: 2, max: 6, step: 1, default: 5 },
      { key: "maxItems", label: "Most events shown (today and tomorrow)", kind: "number", min: 2, max: 20, step: 1, default: 7 },
      { key: "showBirthday", label: "Show the next birthday", kind: "toggle", default: true },
      { key: "allowAdd", label: "Allow adding events from the screen", kind: "toggle", default: false },
      { key: "allowErase", label: "Allow erasing events from the screen", kind: "toggle", default: false },
      SIZE(),
      ...CARD_FIELDS
    ]
  },
  people: {
    name: "Who's home", icon: "👪", minChrome: 44,
    description: "Family members with their pictures, home or away.",
    size: { w: 60, h: 14 },
    fields: [
      { key: "people", label: "People", kind: "rows", max: 10, fields: PEOPLE_ROW, default: [] },
      { key: "showStatus", label: "Show where and since when", kind: "toggle", default: true },
      SIZE(),
      ...withDefaults(CARD_FIELDS, { bgOpacity: 0, outline: false, padding: 0 })
    ]
  },
  todo: {
    name: "To-do list", icon: "🛒", minChrome: 44, interactive: true,
    description: "A Home Assistant to-do list, like the shopping list. Tap to open it.",
    size: { w: 40, h: 12 },
    fields: [
      { key: "entity", label: "List", kind: "entity", domain: "todo", default: "" },
      { key: "title", label: "Title", kind: "text", default: "Shopping list" },
      { key: "icon", label: "Icon", kind: "text", default: "🛒" },
      { key: "preview", label: "Items shown on the card", kind: "number", min: 0, max: 10, step: 1, default: 4 },
      { key: "allowAdd", label: "Allow adding items", kind: "toggle", default: true },
      { key: "allowCheck", label: "Allow checking items off", kind: "toggle", default: true },
      SIZE(),
      ...TILE_FIELDS
    ]
  },
  chores: {
    name: "Kids' chores", icon: "🧹", minChrome: 44, interactive: true,
    description: "One chip per kid with their Home Assistant chore list. Tap a kid to check things off.",
    size: { w: 60, h: 12 },
    fields: [
      { key: "title", label: "Title", kind: "text", default: "Chores" },
      { key: "kids", label: "Kids", kind: "rows", max: 8, fields: [
        { key: "entity", label: "Chore list", kind: "entity", domain: "todo", default: "" },
        { key: "name", label: "Name", kind: "text", default: "" },
        { key: "person", label: "Person (for the picture)", kind: "entity", domain: "person", optional: true, default: "" },
        { key: "color", label: "Colour", kind: "color", default: "#ffb257" }
      ], default: [] },
      { key: "allowCheck", label: "Allow checking chores off", kind: "toggle", default: true },
      { key: "allowAdd", label: "Allow adding a chore", kind: "toggle", default: true },
      { key: "footer", label: "Reminder next to the count", kind: "text", default: "by 5 PM" },
      { key: "chipLayout", label: "Kid chips", kind: "select", options: [["stacked", "Picture above the name"], ["row", "Picture beside the name"]], default: "stacked" },
      SIZE(),
      ...CARD_FIELDS
    ]
  },
  since: {
    name: "Time since", icon: "⏱", minChrome: 44, interactive: true,
    description: "How long since something happened (the dogs went out), with a reminder ring and a button.",
    size: { w: 40, h: 12 },
    fields: [
      { key: "entity", label: "Last time (date/time helper)", kind: "entity", domain: "input_datetime", default: "" },
      { key: "intervalEntity", label: "Reminder minutes (number helper, optional)", kind: "entity", domain: "input_number", default: "" },
      { key: "interval", label: "Reminder minutes (if no helper)", kind: "number", min: 5, max: 1440, step: 5, default: 90 },
      { key: "icon", label: "Icon", kind: "text", default: "🐕" },
      { key: "label", label: "Label", kind: "text", default: "Dogs out" },
      { key: "dueLabel", label: "Label when overdue", kind: "text", default: "Dogs need out" },
      { key: "script", label: "Button runs (script)", kind: "entity", domain: "script", default: "" },
      { key: "buttonLabel", label: "Button label", kind: "text", default: "They just went out" },
      SIZE(),
      ...TILE_FIELDS
    ]
  },
  button: {
    name: "Button", icon: "🔘", minChrome: 44, interactive: true,
    description: "Start a script or a vacuum from the screen, with its status underneath.",
    size: { w: 30, h: 12 },
    fields: [
      { key: "action", label: "What it does", kind: "select", options: [["script", "Run a script"], ["vacuum", "Vacuum: start / send home"], ["toggle", "Turn on / off"],
        ["view", "Go to another view"], ["kids", "Grandkids mode: on with a tap, off with the screen's PIN"]], default: "script" },
      { key: "entity", label: "Script, vacuum or switch", kind: "entity", default: "" },
      { key: "view", label: "View to go to", kind: "view", default: "" },
      { key: "icon", label: "Icon", kind: "text", default: "🤖" },
      { key: "label", label: "Label (blank = HA name)", kind: "text", default: "" },
      { key: "labelOn", label: "Label while Grandkids mode is on", kind: "text", default: "" },
      { key: "pinOwner", label: "Whose PIN turns Grandkids mode off (shown on the keypad, e.g. Grandma)", kind: "text", default: "" },
      { key: "look", label: "Look", kind: "select", options: [["tile", "Tile with status"], ["pill", "Dark pill"], ["pill-light", "Light pill, orange outline"]], default: "tile" },
      { key: "ring", label: "Show a ring counting down to the idle view", kind: "toggle", default: false },
      { key: "confirm", label: "Ask before doing it", kind: "toggle", default: true },
      SIZE(),
      ...TILE_FIELDS
    ]
  },
  sky: {
    name: "Sky", icon: "🌅", minChrome: 44,
    description: "A sky that follows the real sunrise and sunset, with the moon, a 12-hour temperature ribbon and one useful weather line.",
    size: { w: 100, h: 30 },
    fields: [
      { key: "entity", label: "Weather entity", kind: "entity", domain: "weather", default: "" },
      { key: "sun", label: "Sun entity", kind: "entity", domain: "sun", default: "sun.sun" },
      { key: "showWeather", label: "Show temperature and conditions", kind: "toggle", default: true },
      { key: "showRibbon", label: "Show the 12-hour ribbon", kind: "toggle", default: true },
      { key: "showTip", label: "Show the weather line", kind: "toggle", default: true },
      { key: "backdrop", label: "Paint the sky behind the whole screen", kind: "toggle", default: true },
      SIZE()
    ]
  },
  cameras: {
    name: "Who came by", icon: "🎥", minChrome: 44, interactive: true,
    description: "Recent Frigate events (snapshots and clips), never a live stream.",
    size: { w: 100, h: 18 },
    fields: [
      { key: "cameras", label: "Cameras", kind: "rows", max: 12, fields: [
        { key: "camera", label: "Frigate camera", kind: "camera", default: "" },
        { key: "name", label: "Name", kind: "text", default: "" }
      ], default: [] },
      { key: "count", label: "Snapshots shown", kind: "number", min: 1, max: 8, step: 1, default: 5 },
      { key: "title", label: "Heading", kind: "text", default: "Who came by" },
      { key: "note", label: "Note beside the heading", kind: "text", default: "saved camera events · nothing streams" },
      SIZE(),
      ...CARD_FIELDS
    ]
  },
  panel: {
    name: "Card", icon: "🗂", minChrome: 44,
    description: "A see-through card with a heading, to group the widgets you place on top of it.",
    size: { w: 40, h: 30 },
    fields: [
      { key: "look", label: "Look", kind: "select", options: [["card", "See-through card"], ["whiteboard", "Whiteboard (metal frame, faint old writing)"]], default: "card" },
      { key: "title", label: "Heading", kind: "text", default: "House" },
      { key: "note", label: "Note beside the heading", kind: "text", default: "" },
      SIZE(),
      ...CARD_FIELDS
    ]
  },
  status: {
    name: "Status tile", icon: "🫧", minChrome: 44,
    description: "Several things in one tile, quiet until one is busy: the washer and dryer.",
    size: { w: 32, h: 5 },
    fields: [
      { key: "title", label: "Title", kind: "text", default: "Laundry" },
      { key: "icon", label: "Icon", kind: "text", default: "🫧" },
      { key: "idleText", label: "When nothing is going on", kind: "text", default: "All quiet" },
      { key: "items", label: "Things", kind: "rows", max: 6, fields: [
        { key: "entity", label: "Busy flag (on = running)", kind: "entity", default: "" },
        { key: "status", label: "Status text (e.g. 'Washer finished at 10:35 AM')", kind: "entity", optional: true, default: "" },
        { key: "name", label: "Name", kind: "text", default: "" }
      ], default: [] },
      { key: "staleHours", label: "Ignore anything older than (hours)", kind: "number", min: 1, max: 72, step: 1, default: 12 },
      SIZE(),
      ...TILE_FIELDS
    ]
  },
  wbcal: {
    name: "Whiteboard calendar", icon: "🗓", minChrome: 44, interactive: true,
    description: "Five rolling weeks in marker, made for a grandparent's frame. Tap a day to see it; press and hold to write or erase; bring back what was erased.",
    size: { w: 77, h: 89 },
    fields: [
      { key: "calendars", label: "Markers (calendars)", kind: "rows", max: 6, fields: [
        { key: "entity", label: "Calendar", kind: "entity", domain: "calendar", default: "" },
        { key: "name", label: "Marker name (e.g. Me, Family)", kind: "text", default: "" },
        { key: "color", label: "Marker colour", kind: "color", default: "#6a3fa6" },
        { key: "birthdays", label: "Birthdays", kind: "toggle", default: false }
      ], default: [] },
      { key: "allowAdd", label: "Allow writing on it", kind: "toggle", default: true },
      { key: "allowErase", label: "Allow erasing (and bringing back)", kind: "toggle", default: true },
      { key: "owner", label: "Who to ask while Grandkids mode is on (e.g. Grandma)", kind: "text", default: "" },
      { key: "quickPicks", label: "Quick picks (comma separated; end with … to open the keyboard)", kind: "text", default: "Doctor, Hair, Church, Lunch with…, Call…, Birthday, Pick up meds, Grandkids over" },
      SIZE(2.08)
    ]
  },
  sticky: {
    name: "Sticky note", icon: "🗒", minChrome: 44,
    description: "A yellow note: today's plans, tomorrow's first one, and the next birthday.",
    size: { w: 33, h: 27 },
    fields: [
      { key: "calendars", label: "Calendars", kind: "rows", max: 6, fields: [
        { key: "entity", label: "Calendar", kind: "entity", domain: "calendar", default: "" },
        { key: "name", label: "Marker name (e.g. Me, Family)", kind: "text", default: "" },
        { key: "color", label: "Marker colour", kind: "color", default: "#6a3fa6" },
        { key: "birthdays", label: "Birthdays", kind: "toggle", default: false }
      ], default: [] },
      { key: "title", label: "Title", kind: "text", default: "Today" },
      { key: "emptyText", label: "When nothing is planned", kind: "text", default: "Nothing planned. Enjoy it!" },
      { key: "birthdayDays", label: "Show a birthday this many days ahead", kind: "number", min: 0, max: 60, step: 1, default: 10 },
      SIZE(2.08)
    ]
  },
  drawing: {
    name: "Drawing board", icon: "🖍", minChrome: 44, interactive: true,
    description: "A full whiteboard to draw on: a grown-ups' page and a Play page with big markers, rainbow and stamps.",
    size: { w: 100, h: 100 },
    fields: [
      { key: "board", label: "Board name (the drawing preview and photos use it)", kind: "text", default: "whiteboard" },
      { key: "notesTitle", label: "Grown-ups' page", kind: "text", default: "Notes" },
      { key: "playTitle", label: "Play page", kind: "text", default: "Play" },
      { key: "notesColors", label: "Grown-ups' marker colours", kind: "text", default: "#6a3fa6, #1d8a4b, #c8282b, #22262b" },
      { key: "allowFridge", label: "\"Put it on the fridge\" button", kind: "toggle", default: true },
      { key: "backView", label: "Back button goes to view", kind: "view", default: "" },
      { key: "backLabel", label: "Back button label", kind: "text", default: "‹ Calendar" },
      SIZE(2.08)
    ]
  },
  drawtile: {
    name: "Drawing preview", icon: "🖼", minChrome: 44,
    description: "A small tile with the latest drawing; tap it to open the drawing board.",
    size: { w: 19, h: 60 },
    fields: [
      { key: "board", label: "Board name", kind: "text", default: "whiteboard" },
      { key: "title", label: "Title", kind: "text", default: "Whiteboard" },
      { key: "view", label: "Tapping it opens view", kind: "view", default: "" },
      SIZE(2.08)
    ]
  },
  terrarium: {
    name: "Terrarium", icon: "🌿", minChrome: 44, interactive: true,
    description: "The lab at a glance as a living terrarium: a plant per Proxmox host, fireflies for services, the tank pool as water. Tap a plant or the fireflies for details.",
    size: { w: 100, h: 100 },
    fields: [
      { key: "title", label: "Title", kind: "text", default: "Terrarium" },
      { key: "precious", label: "Service that blooms (the one that matters)", kind: "text", default: "immich" },
      { key: "hotTemp", label: "A host is hot from (°C)", kind: "number", min: 50, max: 110, step: 1, default: 85 },
      { key: "busyCpu", label: "A host is busy from (CPU %)", kind: "number", min: 10, max: 100, step: 5, default: 75 },
      SIZE(2.03)
    ]
  },
  icons: {
    name: "Status icons", icon: "🚪", minChrome: 44,
    description: "A row of small icons: doors, locks, the garage, a temperature. Turns yellow when something is open.",
    size: { w: 32, h: 5 },
    fields: [
      { key: "items", label: "Icons", kind: "rows", max: 8, fields: [
        { key: "entity", label: "Entity", kind: "entity", default: "" },
        { key: "name", label: "Name", kind: "text", default: "" },
        { key: "kind", label: "Kind", kind: "select", options: [["door", "Door"], ["garage", "Garage door"], ["lock", "Lock"], ["temp", "Temperature"]], default: "door" }
      ], default: [] },
      SIZE()
    ]
  }
};

const VIEW_FIELDS = [
  { key: "background", label: "Background", kind: "color", default: "#0b0f14" },
  { key: "textColor", label: "Text colour", kind: "color", default: "#ffffff" },
  { key: "font", label: "Font", kind: "select", options: [["sans", "Sans"], ["manrope", "Manrope (rounded)"], ["nunito", "Nunito (friendly)"], ["serif", "Serif"], ["mono", "Monospace"], ["condensed", "Condensed"]], default: "sans" },
  { key: "accentFont", label: "Headline font (clock, temperatures, event titles)", kind: "select", options: [["", "Same as the text"], ["fraunces", "Fraunces (elegant serif)"], ["serif", "Serif"]], default: "" },
  { key: "touchView", label: "A tap anywhere switches to view", kind: "view", default: "" },
  { key: "idleView", label: "Without a touch, go back to view", kind: "view", default: "" },
  { key: "idleSeconds", label: "…after this many seconds", kind: "number", min: 10, max: 3600, step: 10, default: 60 }
];

const MAX_WIDGETS = 40;

function defaultsFor(type) {
  const out = {};
  for (const f of WIDGETS[type].fields) out[f.key] = Array.isArray(f.default) ? [] : f.default;
  return out;
}

function cleanField(f, v) {
  switch (f.kind) {
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) return f.default;
      return Math.min(f.max, Math.max(f.min, Math.round(n * 100) / 100));
    }
    case "toggle": return v === true || v === false ? v : f.default;
    case "color": return v === "" && f.default === "" ? "" : COLOR.test(String(v)) ? String(v).toLowerCase() : f.default;
    case "select": return f.options.some(([val]) => val === v) ? v : f.default;
    case "album": return /^[0-9a-f-]{36}$/.test(String(v)) ? String(v) : "";
    case "entity": {
      const s = String(v === undefined ? f.default : v || "");
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(s) || s.length > 120) return "";
      return f.domain && !s.startsWith(f.domain + ".") ? "" : s;
    }
    case "view": return /^view-[0-9a-f]{10}$/.test(String(v || "")) ? String(v) : "";
    case "camera": return /^[A-Za-z0-9_-]{1,64}$/.test(String(v || "")) ? String(v) : "";
    case "rows": {
      const rows = Array.isArray(v) ? v.slice(0, f.max || 10) : [];
      return rows.map((r) => {
        const out = {};
        for (const sub of f.fields) out[sub.key] = cleanField(sub, r && typeof r === "object" ? r[sub.key] : undefined);
        return out;
      }).filter((r) => f.fields.every((sub) => sub.optional || !["entity", "camera"].includes(sub.kind) || r[sub.key]));
    }
    case "text": return String(v ?? f.default).slice(0, 200);
    case "textarea": return String(v ?? f.default).slice(0, 2000);
    default: return f.default;
  }
}

const pct = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d;
};

// Turn whatever the editor sent into a well-formed view. Unknown widget types
// and properties are dropped; numbers are clamped.
function cleanView(input) {
  const v = input && typeof input === "object" ? input : {};
  const out = {
    aspect: { w: pct(v.aspect && v.aspect.w, 100, 8000, 1280), h: pct(v.aspect && v.aspect.h, 100, 8000, 800) },
    widgets: []
  };
  for (const f of VIEW_FIELDS) out[f.key] = cleanField(f, v[f.key]);
  const seen = new Set();
  for (const w of Array.isArray(v.widgets) ? v.widgets.slice(0, MAX_WIDGETS) : []) {
    if (!w || !WIDGETS[w.type]) continue;
    let id = /^[A-Za-z0-9_-]{1,40}$/.test(String(w.id)) ? String(w.id) : null;
    if (!id || seen.has(id)) id = "w" + Math.random().toString(36).slice(2, 10);
    seen.add(id);
    const props = {};
    const given = w.props && typeof w.props === "object" ? w.props : {};
    for (const f of WIDGETS[w.type].fields) props[f.key] = cleanField(f, given[f.key]);
    const width = pct(w.w, 1, 100, 30), height = pct(w.h, 1, 100, 20);
    out.widgets.push({
      id, type: w.type, props,
      x: pct(w.x, -50, 100, 0), y: pct(w.y, -50, 100, 0), w: width, h: height
    });
  }
  return out;
}

function blankView() {
  return cleanView({
    aspect: { w: 1280, h: 800 },
    widgets: [
      { id: "photos", type: "photos", x: 0, y: 0, w: 100, h: 100, props: defaultsFor("photos") },
      { id: "clock", type: "clock", x: 3, y: 4, w: 34, h: 20, props: defaultsFor("clock") }
    ]
  });
}

// What a display needs for a given view: Home Assistant states, Immich
// albums, and household data keys (lib/household.js) with what feeds them.
function viewNeeds(view) {
  const entities = new Set(), albums = new Set(), data = new Set(), people = new Set();
  const calendars = new Map(), todos = new Set(), forecasts = new Set(), cameras = {}, boards = new Set();
  const entityFields = (fields, props) => {
    for (const f of fields) {
      if (f.kind === "entity" && props[f.key]) entities.add(props[f.key]);
      if (f.kind === "rows") for (const r of props[f.key] || []) entityFields(f.fields, r);
    }
  };
  for (const w of (view && view.widgets) || []) {
    const spec = WIDGETS[w.type], p = w.props;
    if (!spec) continue;
    entityFields(spec.fields, p);
    if (p.albumId) albums.add(p.albumId);
    if (w.type === "wbcal" || w.type === "sticky") for (const c of p.calendars || []) {
      calendars.set(c.entity, calendars.get(c.entity) || c.birthdays);
      data.add("cal:" + c.entity);
    }
    for (const b of [w.type === "drawing" || w.type === "drawtile" ? p.board : "", w.type === "photos" ? p.fridgeBoard : ""]) if (BOARD.test(b || "")) boards.add(b);
    if (w.type === "terrarium") data.add("lab");
    if (w.type === "calendar") for (const c of p.calendars || []) {
      calendars.set(c.entity, calendars.get(c.entity) || c.birthdays);
      data.add("cal:" + c.entity);
    }
    if (w.type === "todo" && p.entity) { todos.add(p.entity); data.add("todo:" + p.entity); }
    if (w.type === "chores") for (const k of p.kids || []) {
      todos.add(k.entity); data.add("todo:" + k.entity);
      if (k.person) people.add(k.person);
    }
    if (w.type === "people") for (const r of p.people || []) people.add(r.entity);
    if (w.type === "sky" && p.entity) { forecasts.add(p.entity); data.add("fc:" + p.entity); }
    if (w.type === "cameras" && (p.cameras || []).length) {
      for (const c of p.cameras) cameras[c.camera] = c.name || c.camera;
      data.add("cams");
    }
  }
  for (const e of entities) if (e.startsWith("calendar.")) entities.delete(e);
  return {
    entities: [...entities], albums: [...albums], data: [...data], people: [...people],
    calendars: [...calendars].map(([entity, birthdays]) => ({ entity, birthdays: Boolean(birthdays) })),
    todos: [...todos], forecasts: [...forecasts], cameras, boards: [...boards]
  };
}

// Views a view can lead to: its tap/idle views and widgets' "view" fields.
function viewLinks(view) {
  const out = new Set();
  if (!view) return [];
  for (const f of VIEW_FIELDS) if (f.kind === "view" && view[f.key]) out.add(view[f.key]);
  for (const w of view.widgets || []) {
    const spec = WIDGETS[w.type];
    for (const f of (spec && spec.fields) || []) if (f.kind === "view" && w.props[f.key]) out.add(w.props[f.key]);
  }
  return [...out];
}

// Widgets in a view that a display with this Chromium version cannot run.
function unsupportedFor(view, chrome) {
  if (!chrome) return [];
  return ((view && view.widgets) || [])
    .filter((w) => WIDGETS[w.type].minChrome > chrome)
    .map((w) => ({ id: w.id, type: w.type, needs: WIDGETS[w.type].minChrome }));
}

function catalog() {
  return { widgets: WIDGETS, viewFields: VIEW_FIELDS, maxWidgets: MAX_WIDGETS };
}

module.exports = { WIDGETS, VIEW_FIELDS, cleanView, blankView, defaultsFor, viewNeeds, viewLinks, unsupportedFor, catalog };
