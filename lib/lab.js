// The lab at a glance, for the Terrarium widget: Proxmox hosts and their
// guests, service probes, the tank pool, internet speed and firing alerts,
// all from Prometheus. Refreshed every 30 s while a view needs it;
// the result is household data key "lab" (lib/household.js pushes it).
//
// Queries, with the labels they rely on:
//   node_uname_info{instance,nodename}          host names (node_exporter)
//   node_cpu_seconds_total, node_memory_*        host CPU / memory
//   node_hwmon_temp_celsius                      hottest sensor per host
//   pve_guest_info{id,name,node,type}, pve_up    guests (pve-exporter; every
//                                                node reports the cluster, so
//                                                series are deduped by id)
//   probe_success{job=~"blackbox_.*",service,category,importance,host}
//   node_filesystem_*{mountpoint="/tank"}        the tank pool
//   node_zfs_zpool_state                         pools not online
//   myspeed_download / _upload / _ping           internet speed
//   <storageMetric>_{up,size_bytes,avail_bytes}{name}   extra stores ("nas",
//                                                "ssd-backup"), e.g. from a
//                                                node_exporter textfile script
//   pve_disk_*{id=~"storage/<node>/local-zfs"}    each host's own pool
//   nvme_*, smartmon_device_smart_healthy         each host's disks
//   /api/v1/alerts                               firing alerts

// storageMetric: prefix of the extra-store metrics (LAB_STORAGE_METRIC).
// hostPattern: regex for Proxmox host names (LAB_HOST_PATTERN, e.g. "^pve");
// hosts that match are shown even without guests, and the match is shortened
// to "host " in the label (pve01 -> host 01). Blank: hosts that run guests.
function createLab({ url, fetchImpl = fetch, log = () => {}, storageMetric = "coreview_storage", hostPattern = "" }) {
  const hostRe = hostPattern ? new RegExp(hostPattern) : null;
  const root = String(url || "").replace(/\/+$/, "");
  async function query(q) {
    const rsp = await fetchImpl(`${root}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) });
    if (!rsp.ok) throw new Error(`Prometheus said ${rsp.status}`);
    const body = await rsp.json();
    return (body.data && body.data.result) || [];
  }
  const num = (r) => { const n = Number(r.value && r.value[1]); return Number.isFinite(n) ? n : null; };
  const byInstance = (rows) => { const o = {}; for (const r of rows) o[r.metric.instance] = num(r); return o; };
  const round = (n, d = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

  async function snapshot() {
    if (!root) return { ok: false, error: "Prometheus isn't set up" };
    const [uname, nodeUp, cpu, mem, temp, uptime, guests, guestUp, probes, tankUsed, pools, down, upl, ping, alertsRsp,
      tankSize, storeUp, storeSize, storeAvail, localZfs, nvmeWear, nvmeSpare, nvmeSpareMin, nvmeCrit, nvmeErr, smart, diskInfo] = await Promise.all([
      query("node_uname_info"),
      query('up{job="node"}'),
      query('1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
      query("1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes"),
      query("max by (instance) (node_hwmon_temp_celsius)"),
      query("time() - node_boot_time_seconds"),
      query("pve_guest_info{template=\"0\"}"),
      query('pve_up{id=~"(qemu|lxc)/.*"}'),
      query('probe_success{job=~"blackbox_.*"}'),
      query('1 - node_filesystem_avail_bytes{mountpoint="/tank"} / node_filesystem_size_bytes{mountpoint="/tank"}'),
      query('node_zfs_zpool_state{state!="online"} == 1'),
      query("myspeed_download"), query("myspeed_upload"), query("myspeed_ping"),
      fetchImpl(`${root}/api/v1/alerts`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null),
      query('node_filesystem_size_bytes{mountpoint="/tank"}'),
      query(`${storageMetric}_up`), query(`${storageMetric}_size_bytes`), query(`${storageMetric}_avail_bytes`),
      query('pve_disk_usage_bytes{id=~"storage/.*/local-zfs"} / pve_disk_size_bytes'),
      query("nvme_percentage_used_ratio"), query("nvme_available_spare_ratio"), query("nvme_available_spare_threshold_ratio"),
      query("nvme_critical_warning_total"), query("nvme_media_errors_total"),
      query("smartmon_device_smart_healthy"),
      query('node_disk_info{device=~"nvme[0-9]+n[0-9]+|sd[a-z]+"}')
    ]);
    // Each host's own storage: its local ZFS pool and its disks' health.
    const zfsBy = {};
    for (const r of localZfs) { const node = String(r.metric.id).split("/")[1]; if (zfsBy[node] === undefined) zfsBy[node] = num(r); }
    const disksBy = {};
    const disk = (inst, dev) => {
      const list = disksBy[inst] = disksBy[inst] || [];
      let d = list.find((x) => x.device === dev);
      if (!d) { d = { device: dev, model: "", wear: null, spare: null, spareMin: null, critical: 0, mediaErrors: 0, healthy: null }; list.push(d); }
      return d;
    };
    for (const r of diskInfo) disk(r.metric.instance, r.metric.device).model = String(r.metric.model || "").replace(/_/g, " ");
    for (const r of nvmeWear) disk(r.metric.instance, r.metric.device).wear = num(r);
    for (const r of nvmeSpare) disk(r.metric.instance, r.metric.device).spare = num(r);
    for (const r of nvmeSpareMin) disk(r.metric.instance, r.metric.device).spareMin = num(r);
    for (const r of nvmeCrit) disk(r.metric.instance, r.metric.device).critical = num(r) || 0;
    for (const r of nvmeErr) disk(r.metric.instance, r.metric.device).mediaErrors = num(r) || 0;
    for (const r of smart) disk(r.metric.instance, String(r.metric.disk || "").replace(/^\/dev\//, "").replace(/^(nvme\d+)$/, "$1n1")).healthy = num(r) === 1;
    const degradedBy = {};
    for (const r of pools) (degradedBy[r.metric.instance] = degradedBy[r.metric.instance] || []).push(`${r.metric.zpool} (${r.metric.state})`);
    const cpuBy = byInstance(cpu), memBy = byInstance(mem), tempBy = byInstance(temp), upBy = byInstance(nodeUp), uptimeBy = byInstance(uptime);
    const running = {};
    for (const r of guestUp) running[r.metric.id] = num(r) === 1;
    const guestsBy = {}, seen = new Set();
    for (const r of guests) {
      const m = r.metric;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      (guestsBy[m.node] = guestsBy[m.node] || []).push({ id: Number(String(m.id).split("/")[1]), name: m.name, type: m.type, up: Boolean(running[m.id]) });
    }
    // Proxmox hosts are the node_exporter hosts that pve-exporter knows as nodes.
    const hosts = [];
    for (const r of uname) {
      const name = r.metric.nodename, inst = r.metric.instance;
      if (!guestsBy[name] && !(hostRe && hostRe.test(name))) continue;
      const list = (guestsBy[name] || []).sort((a, b) => a.id - b.id);
      hosts.push({
        name, label: hostRe ? name.replace(hostRe, "host ") : name, up: upBy[inst] === 1, cpu: round(cpuBy[inst], 3), mem: round(memBy[inst], 3), temp: round(tempBy[inst]),
        uptimeDays: uptimeBy[inst] === null || uptimeBy[inst] === undefined ? null : Math.floor(uptimeBy[inst] / 86400),
        guests: list, running: list.filter((g) => g.up).length,
        storage: { localUsed: round(zfsBy[name] === undefined ? null : zfsBy[name], 3), disks: (disksBy[inst] || []).filter((d) => d.model || d.wear !== null),
          poolsDegraded: degradedBy[inst] || [] }
      });
    }
    hosts.sort((a, b) => (a.name < b.name ? -1 : 1));
    // One entry per service (DNS is probed twice, over UDP and TCP).
    const services = {}, svcList = [];
    for (const r of probes) {
      const m = r.metric, key = m.service || m.instance;
      const s = services[key] || (services[key] = { name: key, category: m.category || "other", core: m.importance === "core", host: m.host || "", up: true });
      if (num(r) !== 1) s.up = false;
    }
    for (const k of Object.keys(services).sort()) svcList.push(services[k]);
    const alerts = ((alertsRsp && alertsRsp.data && alertsRsp.data.alerts) || []).filter((a) => a.state === "firing")
      .map((a) => ({ name: a.labels.alertname, severity: a.labels.severity || "", instance: a.labels.instance || a.labels.service || "", summary: (a.annotations && (a.annotations.summary || a.annotations.description)) || "" }));
    const first = (rows) => (rows.length ? num(rows[0]) : null);
    return {
      ok: true, at: Date.now(), hosts, services: svcList,
      tank: { used: round(first(tankUsed), 3), poolsDegraded: pools.filter((r) => r.metric.zpool === "tank").map((r) => `${r.metric.zpool} (${r.metric.state})`) },
      stores: [
        { name: "tank", label: "tank", note: "photos & media", up: tankUsed.length > 0, used: round(first(tankUsed), 3), size: first(tankSize) },
        ...["nas", "ssd-backup"].map((n) => {
          const up = storeUp.find((r) => r.metric.name === n), size = storeSize.find((r) => r.metric.name === n), avail = storeAvail.find((r) => r.metric.name === n);
          const sz = size ? num(size) : null, av = avail ? num(avail) : null;
          return { name: n, label: n === "nas" ? "nas" : "backup", note: n === "nas" ? "cold store" : "backup SSD",
            up: up ? num(up) === 1 : null, used: sz && av !== null ? round(1 - av / sz, 3) : null, size: sz };
        })
      ],
      internet: { down: round(first(down)), up: round(first(upl)), ping: round(first(ping)) },
      alerts
    };
  }
  return {
    configured: () => Boolean(root),
    async refresh() {
      try { return await snapshot(); }
      catch (err) { log("lab:", err.message); return { ok: false, error: err.message }; }
    }
  };
}

module.exports = { createLab };
