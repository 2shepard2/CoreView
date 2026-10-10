// Ported from an earlier standalone house board app.
// "Who came by": recent Frigate events, read from Frigate's saved events only.
// Nothing here opens a camera stream: snapshots and clips are recordings that
// already exist, so the cameras' motion-triggered on/off design is untouched.
function createFrigate({ url, cameras, fetchImpl = fetch, windowHours = 12, groupMinutes = 30 }) {
  const root = String(url || "").replace(/\/+$/, "");
  let known = new Set();

  async function recent() {
    const after = Math.floor(Date.now() / 1000) - windowHours * 3600;
    const camList = Object.keys(cameras).join(",");
    const rsp = await fetchImpl(`${root}/api/events?limit=200&has_snapshot=1&cameras=${encodeURIComponent(camList)}&after=${after}`);
    if (!rsp.ok) throw new Error(`Frigate events failed (${rsp.status})`);
    const events = (await rsp.json()).filter((e) => cameras[e.camera] && !e.false_positive);
    known = new Set(events.map((e) => e.id));
    return group(events);
  }

  // Collapse repeats: same camera + label within `groupMinutes` of the newer one
  // becomes one card with a count, showing the newest snapshot.
  function group(events) {
    const out = [];
    for (const e of events.sort((a, b) => b.start_time - a.start_time)) {
      const g = out.find((x) => x.camera === e.camera && x.label === e.label && x.oldest - e.start_time < groupMinutes * 60);
      if (g) { g.count++; g.oldest = e.start_time; continue; }
      const d = e.data || {};
      out.push({ id: e.id, camera: e.camera, cameraName: cameras[e.camera], label: e.label, subLabel: Array.isArray(e.sub_label) ? e.sub_label[0] : e.sub_label || null,
        time: e.start_time, oldest: e.start_time, count: 1, hasClip: Boolean(e.has_clip), alert: d.max_severity === "alert", box: Array.isArray(d.box) ? d.box : null });
    }
    return out;
  }

  // Proxy one image or clip for an event we listed (never an arbitrary path).
  async function media(id, kind, range) {
    if (!known.has(id)) return null;
    const pathFor = { snap: "snapshot-clean.webp", thumb: "thumbnail.webp", clip: "clip.mp4" }[kind];
    if (!pathFor) return null;
    return fetchImpl(`${root}/api/events/${encodeURIComponent(id)}/${pathFor}`, range ? { headers: { Range: range } } : {});
  }

  return { recent, media, group };
}

module.exports = { createFrigate };
