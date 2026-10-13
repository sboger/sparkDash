/**
 * Mac (Apple Silicon) units (platform: "darwin"): the GPU/ANE/power/thermal
 * counters Apple publishes only through private frameworks, so the collector
 * shells out to macmon (https://github.com/vladkens/macmon) over SSH — the
 * same one-shot, sudoless pattern the Windows collector uses with PowerShell.
 * macmon 0.9+ supports M1–M6 and prints one JSON object per sample:
 *
 *   macmon pipe --soc-info -s 1 -i 300
 *
 * Everything arrives in ONE SSH round trip (uptime + the JSON sample), which
 * the SystemCollector caches for ~1.2 s so the fast domains (gpu/cpu/ram) of a
 * poll share a single exec, like the Windows scripts do.
 *
 * Unit conventions in the pipe JSON (verified live on an M-series mini):
 *   - usage ratios (cpu_scaled_ratio, gpu_scaled_ratio, *_active_ratio) are
 *     0..1 → ×100 for percent;
 *   - power fields (*_power, sys_power) are watts;
 *   - memory/swap are bytes; temp averages are °C and can be absent;
 *   - soc.chip_name / soc.gpu_cores / soc.memory_gb identify the machine.
 * A literal 0 for cpu_power/ane_power can mean "CLPC counters unavailable on
 * this chip/macOS build", not a measured 0 W (see macmon's clpc docs) — the
 * parsers treat a 0 draw as unavailable so the UI shows "—", never a fake 0 W.
 */

/** Resolve macmon and run one sample plus the boot time, sectioned for parsing. */
export const MACMON_SCRIPT = [
  "M=$(command -v macmon 2>/dev/null || true)",
  'if [ -z "$M" ]; then for p in /usr/local/bin/macmon /opt/homebrew/bin/macmon; do if [ -x "$p" ]; then M="$p"; break; fi; done; fi',
  "echo __UPTIME__",
  "sysctl -n kern.boottime 2>/dev/null",
  "echo __MACMON__",
  'if [ -n "$M" ]; then "$M" pipe --soc-info -s 1 -i 300 2>/dev/null; fi',
  "exit 0",
].join(";\n");

/** macOS uptime alone (liveness poll): seconds since the 1970 epoch boot stamp. */
export const MAC_UPTIME_SCRIPT = "sysctl -n kern.boottime 2>/dev/null";

/**
 * Interfaces, byte counters and the default route in one round trip. BSD
 * netstat -ibn has no /proc/net/dev equivalent and `ifconfig` lacks counters,
 * so link speed is not reported (the UI keeps its last value).
 */
export const MAC_NETWORK_SCRIPT = [
  "echo __ROUTE__",
  "route -n get default 2>/dev/null",
  "echo __NETSTAT__",
  "netstat -ibn 2>/dev/null",
].join("\n");

const MAC_VIRTUAL_IFACE = /^(utun|bridge|awdl|llw|anpi|ap1|lo0|gif|stf|demux|ipsec|pflog|vmenet)/;

/**
 * @param {string} output  MAC_NETWORK_SCRIPT output
 * @returns {{ primaryInterface: string|null, interfaces: Array<{name, rxSpeed: number, txSpeed: number, ip: string|null, operstate: string, disabled: boolean}> }}
 */
export function parseMacNetwork(output) {
  const sections = String(output ?? "").split(/^__(ROUTE|NETSTAT)__\s*$/m);
  let routePart = "";
  let netPart = "";
  for (let i = 1; i < sections.length - 1; i += 2) {
    if (sections[i] === "ROUTE") routePart = sections[i + 1] ?? "";
    if (sections[i] === "NETSTAT") netPart = sections[i + 1] ?? "";
  }
  const primaryInterface = (routePart.match(/^\s*interface:\s*(\S+)/m) || [])[1] ?? null;

  // One <Link#n> row per interface carries the cumulative byte counters;
  // address-family rows (inet/inet6) carry the IPs.
  const counters = new Map();
  const ips = new Map();
  for (const line of netPart.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7 || parts[0] === "Name") continue;
    const name = parts[0];
    if (MAC_VIRTUAL_IFACE.test(name)) continue;
    if (/^<Link/.test(parts[2] || "")) {
      // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]
      counters.set(name, { rxBytes: parseInt(parts[6], 10) || 0, txBytes: parseInt(parts[9], 10) || 0 });
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(parts[3] || "")) {
      // Address-family row (-n keeps the numeric net in the Network column
      // and the host address in Address).
      if (!ips.has(name)) ips.set(name, parts[3]);
    }
  }
  const interfaces = Array.from(counters.entries()).map(([name, c]) => ({
    name,
    rxBytes: c.rxBytes,
    txBytes: c.txBytes,
    ip: ips.get(name) ?? null,
    operstate: /^(en|eth)/.test(name) ? "up" : "unknown",
    disabled: false,
  }));
  return { primaryInterface, interfaces };
}

/** kern.boottime looks like `{ sec = 1728850000, usec = 123456 } ...`. */
export function parseMacUptime(output) {
  const m = String(output ?? "").match(/sec\s*=\s*(\d+)/);
  if (!m) return null;
  const bootSec = parseInt(m[1], 10);
  if (!Number.isFinite(bootSec) || bootSec <= 0) return null;
  const uptime = Math.floor(Date.now() / 1000) - bootSec;
  return uptime >= 0 ? uptime : null;
}

/** First valid macmon JSON object in `output` (null when macmon is absent/failing). */
export function parseMacmonOutput(output) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && "cpu_scaled_ratio" in obj) return obj;
    } catch {
      // not JSON — keep scanning
    }
  }
  return null;
}

const pct = (ratio) => (Number.isFinite(ratio) ? Math.round(ratio * 1000) / 10 : null);
// A nonzero macmon reading is a real measurement, however small (an idle M6
// GPU measures ~0.003 W at its minimum clock). Only an exact 0 means the
// counter is unmeasured on this chip/macOS build (macmon's CLPC docs).
const watts = (w) => (Number.isFinite(w) && w > 0 ? Math.round(w * 100) / 100 : null);
const tempC = (t) => (Number.isFinite(t) && t > 0 && t < 150 ? Math.round(t * 10) / 10 : null);
const mb = (bytes) => (Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null);

/**
 * @param {string} output  MACMON_SCRIPT output
 * @returns {{ uptime: number|null, sample: object|null }}
 */
export function splitMacmonSections(output) {
  const sections = String(output ?? "").split(/^__(UPTIME|MACMON)__\s*$/m);
  // split with capture groups interleaves text and markers: [pre, "UPTIME", t, "MACMON", m]
  let uptimePart = "";
  let macmonPart = "";
  for (let i = 1; i < sections.length - 1; i += 2) {
    if (sections[i] === "UPTIME") uptimePart = sections[i + 1] ?? "";
    if (sections[i] === "MACMON") macmonPart = sections[i + 1] ?? "";
  }
  return { uptime: parseMacUptime(uptimePart), sample: parseMacmonOutput(macmonPart) };
}

/** GPU-shaped metrics from one macmon sample (percent 0-100, watts, °C). */
export function macmonGpu(sample) {
  if (!sample) return null;
  const temp = tempC(sample.temp?.gpu_temp_avg);
  const usage = pct(sample.gpu_scaled_ratio);
  const draw = watts(sample.gpu_power);
  const soc = sample.soc ?? null;
  const gpuCores = Number.isFinite(soc?.gpu_cores) ? soc.gpu_cores : null;
  const chip = typeof soc?.chip_name === "string" && soc.chip_name ? soc.chip_name : null;
  const device = {
    index: 0,
    name: chip ? `${chip} GPU${gpuCores ? ` (${gpuCores} cores)` : ""}` : "Apple Silicon GPU",
    uuid: null,
    temperature: temp ?? 0,
    usage: usage ?? 0,
    power: { draw: draw ?? 0, limit: 0 },
    // Apple Silicon has no separate card memory: the unified pool is reported
    // through RAM/unified-memory, so VRAM availability stays off (UI shows "—").
    vram: { used: 0, total: 0, percentage: 0, available: 0 },
    metricAvailability: {
      temperature: temp != null,
      usage: usage != null,
      powerDraw: draw != null,
      powerLimit: false,
      vramUsed: false,
      vramTotal: false,
    },
  };
  return {
    temperature: temp ?? 0,
    usage: usage ?? 0,
    power: { draw: draw ?? 0, limit: 0, systemDraw: null },
    sysPower: watts(sample.sys_power),
    throttle: null,
    metricAvailability: { ...device.metricAvailability },
    gpus: [device],
    soc,
  };
}

/** CPU-shaped metrics (macmon's freq-weighted ratio is its "usage %"). */
export function macmonCpu(sample) {
  if (!sample) return null;
  const temp = tempC(sample.temp?.cpu_temp_avg);
  const usage = pct(sample.cpu_scaled_ratio);
  const draw = watts(sample.cpu_power);
  return {
    usage: usage ?? 0,
    temperature: temp ?? 0,
    temperatureLabel: null,
    temperatureSource: temp != null ? "macmon" : null,
    draw: draw ?? 0,
    // macmon does not expose a package power limit; the UI omits "/ tdp W".
    tdp: null,
  };
}

/** { used, total, percentage } in MB from the macmon memory block. */
export function macmonRam(sample) {
  if (!sample) return null;
  const total = mb(sample.memory?.ram_total);
  const used = mb(sample.memory?.ram_usage);
  if (total == null || used == null) return null;
  return { used, total, percentage: Math.min(100, Math.round((used / total) * 100)) };
}
