// The Settings page: connections (status, Test, and changing those not set on
// the server), the LED signs, the admin password, backup/restore, and version
// info.
import { h, api, toast, ago, modal, confirmBox } from "./lib.js";

let redraw = () => {};

// redraw(): app.js renders the page again (after a connection is saved).
export async function settingsPage(onRedraw) {
  if (onRedraw) redraw = onRedraw;
  const s = await api("GET", "/api/settings");
  return [
    h("div.page-head", {}, [h("div", {}, [h("h1", {}, "Settings"), h("p.muted", {}, "How Studio is connected, your sign-in, and backups.")])]),
    connections(s),
    s.signs.length ? signs(s) : null,
    account(s),
    backups(s),
    about(s)
  ];
}

function section(title, sub, body) {
  return h("section.settings-section", {}, [h("div.section-head", {}, [h("h2", {}, title), sub ? h("p.muted", {}, sub) : null]), body]);
}

// Each set-up connection is tested as the page opens, so every badge shows a
// real answer (Immich, Frigate, Jellyfin and Prometheus have no standing
// connection to report otherwise). "Test" runs it again.
function connections(s) {
  const anyServer = s.connections.some((c) => c.lockReason === "server");
  const sub = s.connections.some((c) => c.lockReason === "lock") ? "Locked on the server (SETTINGS_LOCK=1): change connections in .env and secrets/."
    : anyServer ? "Connections marked “set on the server” come from .env and secrets/ and are changed there; the others you can set here."
    : "Set each service's address and key here. Keys are stored on the server and never shown again.";
  return section("Connections", sub, h("div.settings-grid", {}, s.connections.map(connectionCard)));
}

function connectionCard(c) {
  const result = h("div.small.test-result");
  const badge = h("span.badge.grey", {}, c.configured ? "Checking…" : "Not set up");
  const show = (ok, text) => {
    badge.className = `badge ${ok ? "green" : "red"}`;
    badge.textContent = ok ? "● Connected" : "Can't connect";
    result.className = `small test-result ${ok ? "ok" : "bad"}`;
    result.textContent = (ok ? "✓ " : "✗ ") + text;
  };
  const run = async () => {
    btn.disabled = true; result.className = "small test-result"; result.textContent = "Testing…";
    try { const r = await api("POST", `/api/settings/test/${c.id}`); show(r.ok, r.detail); }
    catch (ex) { show(false, ex.message); }
    btn.disabled = false;
  };
  const btn = h("button.btn.small", { onclick: run }, "Test");
  if (c.configured) run();
  const where = c.lockReason === "server" ? "Set on the server" : c.lockReason === "lock" ? "Locked" : c.source === "browser" ? "Set in Studio" : null;
  const keyNote = c.secret && c.source === "browser" ? (c.secret.set ? `${c.secret.label} saved${c.secret.setAt ? " " + new Date(c.secret.setAt).toLocaleDateString() : ""}` : `No ${c.secret.label.toLowerCase()} saved`) : null;
  return h("div.card.setting-card", {}, [h("div.card-body", {}, [
    h("div.card-title-row", {}, [h("h3", {}, c.name), badge]),
    h("div.muted.small", {}, c.what),
    h("div.small.mono", {}, c.url || "—"),
    c.tip ? h("div.muted.small.setting-tip", {}, c.tip) : null,
    where || keyNote ? h("div.muted.small", {}, [where, where && keyNote ? " · " : "", keyNote]) : null,
    h("div.card-actions", {}, [btn, c.locked ? null : h("button.btn.small", { onclick: () => editConnection(c) }, c.url ? "Change…" : "Set up…")]),
    result
  ])]);
}

// Address, user name (MQTT) and key. A typed key is sent once and never shown
// again; changing the address forgets the saved key (the server enforces it).
function editConnection(c) {
  const url = h("input", { value: c.url || "", placeholder: c.example, autocomplete: "off", spellcheck: false });
  const user = c.hasUser ? h("input", { value: c.username || "", autocomplete: "off" }) : null;
  const secret = c.secret ? h("input", { type: "password", autocomplete: "new-password",
    placeholder: c.secret.set ? "Saved. Leave blank to keep it, or paste a new one" : "Paste it here" }) : null;
  const clear = c.secret && c.secret.set ? h("input", { type: "checkbox" }) : null;
  const keyHint = h("div.muted.small");
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const result = h("div.small.test-result");
  const err = h("div.form-error");
  const draft = () => ({ url: url.value, username: user ? user.value : undefined, secret: secret ? secret.value : undefined, clearSecret: clear ? clear.checked : false });
  const hint = () => {
    if (!c.secret || !c.secret.set) return;
    keyHint.textContent = url.value.trim().replace(/\/+$/, "") !== c.url && !secret.value ? `The saved ${c.secret.label.toLowerCase()} belongs to the old address and will be forgotten; paste it again for the new one.` : "";
  };
  url.addEventListener("input", hint);
  if (secret) secret.addEventListener("input", hint);

  const test = async () => {
    result.className = "small test-result"; result.textContent = "Testing…";
    try {
      const r = await api("POST", `/api/settings/test/${c.id}`, { draft: draft() });
      result.className = `small test-result ${r.ok ? "ok" : "bad"}`; result.textContent = (r.ok ? "✓ " : "✗ ") + r.detail;
    } catch (ex) { result.className = "small test-result bad"; result.textContent = "✗ " + ex.message; }
  };
  const save = async (force) => {
    err.textContent = "";
    if (!password.value) { err.textContent = "Type your Studio password to save"; password.focus(); return; }
    try {
      const r = await api("PUT", `/api/settings/connections/${c.id}`, { ...draft(), password: password.value, force: Boolean(force) });
      toast(r.url ? `${c.name} saved${r.test && r.test.ok ? ` · ${r.test.detail}` : ""}` : `${c.name} turned off`);
      m.close();
      redraw();
    } catch (ex) {
      if (ex.status === 422 && await confirmBox("Save anyway?", `${ex.message.replace(/^Not saved: /, "The test failed: ")}. Save these settings anyway?`, "Save anyway", true)) return save(true);
      err.textContent = ex.message;
    }
  };
  const m = modal(`${c.name}`, [
    h("p.muted", {}, `${c.what}. Studio tests the settings before saving them.`),
    h("label.field", {}, ["Address", url]),
    user ? h("label.field", {}, ["User name (blank if the broker has none)", user]) : null,
    secret ? h("label.field", {}, [c.secret.label, secret]) : null,
    keyHint,
    clear ? h("label.check", {}, [clear, ` Remove the saved ${c.secret.label.toLowerCase()}`]) : null,
    h("div.card-actions", {}, [h("button.btn.small", { onclick: test }, "Test these settings")]),
    result,
    h("label.field", {}, ["Your Studio password (to save)", password]),
    err,
    h("p.muted.small", {}, "Clear the address and save to turn this off. Keys are stored on the server, not in backups.")
  ], [h("button.btn.primary", { onclick: () => save(false) }, "Save")]);
}

function signs(s) {
  return section("LED signs", null, h("div.settings-list", {}, s.signs.map((x) => h("div.settings-row", {}, [
    h("div", {}, [h("b", {}, x.name), h("div.muted.small", {}, x.kind)]),
    h("div.small", {}, x.note || [
      x.online ? h("span.badge.green", {}, "● Online") : h("span.badge.amber", {}, `Offline · seen ${ago(x.lastSeen)}`),
      x.firmware ? ` firmware ${x.firmware}` : ""
    ])
  ]))));
}

function account(s) {
  const current = h("input", { type: "password", autocomplete: "current-password" });
  const next = h("input", { type: "password", autocomplete: "new-password", minLength: 8 });
  const again = h("input", { type: "password", autocomplete: "new-password" });
  const err = h("div.form-error");
  const form = h("form.settings-form", { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (next.value !== again.value) { err.textContent = "The new passwords don't match"; return; }
    try {
      await api("POST", "/api/account/password", { current: current.value, next: next.value });
      form.reset();
      toast("Password changed. Other browsers are signed out.");
    } catch (ex) { err.textContent = ex.message; }
  } }, [
    h("p.muted.small", {}, `Signed in as ${s.user}. Changing the password signs out every other browser.`),
    h("div.field-row", {}, [h("label.field", {}, ["Current password", current]), h("label.field", {}, ["New password (8+ characters)", next]),
      h("label.field", {}, ["New password again", again])]),
    err,
    h("button.btn.primary", { type: "submit" }, "Change password")
  ]);
  return section("Account", null, s.user === "agent" ? h("p.muted", {}, "Signed in with the agent token; sign in in a browser to change the password.") : form);
}

function backups(s) {
  const file = h("input", { type: "file", accept: "application/json,.json" });
  const restore = h("button.btn", { onclick: async () => {
    const f = file.files[0];
    if (!f) { toast("Pick a backup file first", "error"); return; }
    let data;
    try { data = JSON.parse(await f.text()); } catch (_e) { toast("That file isn't JSON", "error"); return; }
    const when = data && data.exportedAt ? ` from ${new Date(data.exportedAt).toLocaleString()}` : "";
    if (!await confirmBox("Restore this backup?", `Studio's screens, views and sign settings are replaced with the backup${when}. Your sign-in stays. The current setup is kept on the server in case you need it back.`, "Restore", true)) return;
    try {
      const r = await api("POST", "/api/restore", data);
      toast(`Restored: ${r.screens} screens, ${r.views} views, ${r.displays} paired displays`);
    } catch (ex) { toast(ex.message, "error"); }
  } }, "Restore…");
  return section("Backup", `${s.counts.screens} screens, ${s.counts.views} views, ${s.counts.displays} paired displays. A backup holds those and the sign settings, not your password, connection keys or drawings.`,
    h("div.settings-list", {}, [
      h("div.settings-row", {}, [h("div", {}, [h("b", {}, "Download a backup"), h("div.muted.small", {}, "A JSON file you can keep anywhere.")]),
        h("a.btn.primary", { href: "/api/backup", download: "" }, "Download")]),
      h("div.settings-row", {}, [h("div", {}, [h("b", {}, "Restore from a backup"), h("div.muted.small", {}, "Displays paired to this Studio stay paired.")]),
        h("div.restore-row", {}, [file, restore])])
    ]));
}

function about(s) {
  const up = Math.max(0, s.serverTime - s.startedAt);
  const upText = up < 3600e3 ? `${Math.round(up / 60e3)} min` : up < 864e5 ? `${Math.round(up / 3600e3)} h` : `${Math.round(up / 864e5)} days`;
  return section("About", null, h("div.settings-list", {}, [
    ["Version", `CoreView Studio ${s.version}`], ["Display code", s.codeVersion], ["Time zone", s.timeZone], ["Running for", upText]
  ].map(([k, v]) => h("div.settings-row", {}, [h("span.muted", {}, k), h("span.mono", {}, v)]))));
}
