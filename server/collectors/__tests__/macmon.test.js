import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector, collectionWasSuccessful } from "../SystemCollector.js";
import {
  MACMON_SCRIPT,
  MAC_UPTIME_SCRIPT,
  parseMacUptime,
  parseMacNetwork,
  parseMacmonOutput,
  splitMacmonSections,
} from "../macMetrics.js";
import { SparkRegistry } from "../../sparks/SparkRegistry.js";

// Captured live from minim6 (Mac mini M6, 16 GB) with `macmon pipe --soc-info -s 1 -i 300`.
const SAMPLE = JSON.stringify({
  all_power: 0.04562225937843323,
  ane_power: 0.0,
  cpu_active_ratio: 0.013589712791144848,
  cpu_power: 0.0430830642580986,
  cpu_scaled_ratio: 0.00515224551782012,
  cpu_usage_pct: 0.00515224551782012,
  ecpu_active_ratio: 0.016219090670347214,
  ecpu_freq_mhz: 972,
  ecpu_scaled_ratio: 0.006120562553405762,
  ecpu_usage: [972, 0.006120562553405762],
  fans: [{ max_rpm: 4900, name: "fan0", rpm: 1000 }],
  gpu_active_ratio: 0.020967962220311165,
  gpu_freq_mhz: 502,
  gpu_power: 0.0025391962844878435,
  gpu_ram_power: 0.0,
  gpu_scaled_ratio: 0.006066810805350542,
  gpu_usage: [502, 0.006066810805350542],
  memory: { ram_total: 17179869184, ram_usage: 11501158400, swap_total: 2147483648, swap_usage: 1255538688 },
  pcpu_active_ratio: 0.00044281771988607943,
  pcpu_freq_mhz: 1679,
  pcpu_scaled_ratio: 0.0003106621152255684,
  pcpu_usage: [1679, 0.0003106621152255684],
  ram_power: 0.0,
  soc: {
    chip_name: "Apple M6",
    ecpu_cores: 6,
    ecpu_label: "P",
    gpu_cores: 12,
    mac_model: "Mac18,5",
    memory_gb: 16,
    pcpu_cores: 2,
    pcpu_label: "S",
  },
  sys_power: 1.4186536073684692,
  temp: { cpu_temp_avg: 31.519229888916016, gpu_temp_avg: 31.33767318725586 },
  timestamp: "2026-10-13T20:39:05.305753+00:00",
});

const MACMON_OUT = ["__UPTIME__", "{ sec = 1728850000, usec = 123456 } Sun Oct 13 12:00:00 2026", "__MACMON__", SAMPLE, ""].join("\n");

function macCollector() {
  const collector = new SystemCollector({ id: "minim6", platform: "darwin", kind: "host", isLocal: false, ssh: { host: "192.168.1.223", user: "s" } });
  collector._macRun = async (key) => (key === "metrics" ? MACMON_OUT : "boot");
  return collector;
}

test("MACMON_SCRIPT resolves macmon from PATH or the common install prefixes and needs no sudo", () => {
  assert.match(MACMON_SCRIPT, /command -v macmon/);
  assert.match(MACMON_SCRIPT, /\/usr\/local\/bin\/macmon/);
  assert.match(MACMON_SCRIPT, /\/opt\/homebrew\/bin\/macmon/);
  assert.match(MACMON_SCRIPT, /pipe --soc-info -s 1 -i 300/);
  assert.doesNotMatch(MACMON_SCRIPT, /sudo/);
  assert.equal(MAC_UPTIME_SCRIPT, "sysctl -n kern.boottime 2>/dev/null");
});

test("parseMacUptime reads kern.boottime and rejects junk", () => {
  const now = Math.floor(Date.now() / 1000);
  const up = parseMacUptime(`{ sec = ${now - 3600}, usec = 123456 } Sun Oct 13 12:00:00 2026`);
  assert.ok(up >= 3595 && up <= 3605, `uptime ${up}`);
  assert.equal(parseMacUptime(""), null);
  assert.equal(parseMacUptime("garbage"), null);
});

test("splitMacmonSections isolates the JSON sample from the uptime block", () => {
  const { uptime, sample } = splitMacmonSections(MACMON_OUT);
  assert.equal(uptime, Math.floor(Date.now() / 1000) - 1728850000);
  assert.equal(sample?.soc?.chip_name, "Apple M6");
  // No macmon installed: only sentinels, no JSON.
  assert.deepEqual(splitMacmonSections("__UPTIME__\n\n__MACMON__\n"), { uptime: null, sample: null });
});

test("parseMacmonOutput skips non-JSON noise and requires the macmon shape", () => {
  assert.equal(parseMacmonOutput('{"cpu_scaled_ratio":0.5}\n{"unrelated":true}').cpu_scaled_ratio, 0.5);
  assert.equal(parseMacmonOutput('{"unrelated":true}'), null);
});

test("collectGpu on a Mac unit reads macmon: scaled ratio × 100, °C, watts, no fake VRAM", async () => {
  const gpu = await macCollector().collectGpu();
  assert.equal(gpu.temperature, 31.3);
  assert.equal(gpu.usage, 0.6); // gpu_scaled_ratio 0.006066… × 100, rounded to 0.1
  assert.equal(gpu.power.draw, 0); // the idle M6 GPU measures 0.0025 W, shown as 0 W like macmon's TUI
  assert.equal(gpu.power.limit, 0);
  assert.equal(gpu.metricAvailability.usage, true);
  assert.equal(gpu.metricAvailability.temperature, true);
  assert.equal(gpu.metricAvailability.powerDraw, true); // a nonzero reading is a real measurement
  assert.equal(gpu.metricAvailability.powerLimit, false);
  assert.equal(gpu.metricAvailability.vramTotal, false); // unified memory, not a discrete card
  assert.equal(gpu.vram.total, 0);
  assert.equal(gpu.nvErrNoMemory, 0);
  assert.equal(gpu.kernelErrors, null);
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.gpus[0].name, "Apple M6 GPU (12 cores)");
  assert.deepEqual(gpu.processes, []);
});

test("CPU comes from the same sample: usage, temp, power, and no invented TDP", async () => {
  const cpu = await macCollector().collectCpu();
  assert.equal(cpu.usage, 0.5); // cpu_scaled_ratio 0.005152 × 100
  assert.equal(cpu.temperature, 31.5);
  assert.equal(cpu.draw, 0.04);
  assert.equal(cpu.tdp, null);
  assert.equal(cpu.temperatureSource, "macmon");
});

test("RAM comes from the macmon memory block in MB", async () => {
  const ram = await macCollector().collectRam();
  assert.equal(ram.total, 16384);
  assert.equal(ram.used, 10968);
  assert.equal(ram.percentage, 67);
});

test("hardware detection reads the soc block: chip, cores, GPU cores, RAM", async () => {
  const hw = await macCollector().detectMacHardware();
  assert.equal(hw.device, "Mac (Apple Silicon)");
  assert.equal(hw.cpuModel, "Apple M6");
  assert.equal(hw.cpuCores, 8);
  assert.equal(hw.totalMemoryGB, 16);
  assert.equal(hw.gpuChip, "Apple M6 GPU (12 cores)");
  assert.equal(hw.cudaDriver, null);
});

test("without macmon the collectors degrade instead of throwing, and GPU reads unsuccessful", async () => {
  const c = macCollector();
  c._macRun = async () => "__UPTIME__\n\n__MACMON__\n";
  c._getRemoteRamMac = async () => ({ used: 0, total: 0, percentage: 0 });
  assert.equal((await c.collectRam()).total, 0);
  assert.equal((await c.collectCpu()).usage, 0);
  assert.equal(collectionWasSuccessful(await c.collectGpu()), false);
  assert.equal(await c.detectMacHardware(), null);
});

test("macOS network parsing keeps physical interfaces, their IPs and drops the virtual ones", () => {
  const out = [
    "__ROUTE__",
    "   route to: default",
    "interface: en0",
    "__NETSTAT__",
    "Name  Mtu  Network  Address  Ipkts Ierrs Ibytes Opkts Oerrs Obytes  Coll",
    "en0  1500  <Link#11>  00:11:22:33:44:55  100  0  5000000  90  0  2000000  0",
    "en0  1500  fe80::%en0  fe80::1  100  -  -  90  -  -  0",
    "en0  1500  192.168.1  192.168.1.223  100  -  -  90  -  -  0",
    "utun3  1380  <Link#22>  utun3  0  0  0  0  0  0  0",
    "awdl0  1484  <Link#17>  awdl0  5  0  700  4  0  600  0",
  ].join("\n");
  const net = parseMacNetwork(out);
  assert.equal(net.primaryInterface, "en0");
  assert.deepEqual(net.interfaces.map((i) => i.name), ["en0"]);
  assert.equal(net.interfaces[0].ip, "192.168.1.223");
  assert.equal(net.interfaces[0].rxBytes, 5000000);
  assert.equal(net.interfaces[0].txBytes, 2000000);
  assert.equal(net.interfaces[0].operstate, "up");
});

test("unified memory on a Mac comes from the macmon block, not /proc/meminfo", async () => {
  const c = macCollector();
  const mem = await c.collectUnifiedMemory();
  assert.equal(mem.total, 16384);
  assert.equal(mem.used, 10968);
  assert.equal(mem.cpuUsed, 10968); // no per-process GPU share is reportable
  assert.equal(mem.gpuUsed, 0);
  assert.equal(mem.oomRisk, "medium");
});

test("the registry keeps platform darwin and the host kind the Add dialog set", () => {
  const registry = Object.create(SparkRegistry.prototype);
  const spark = registry._normalizeConfig({
    id: "minim6",
    name: "minim6",
    platform: "darwin",
    kind: "host",
    isLocal: false,
    lanIp: "192.168.1.223",
    ssh: { host: "192.168.1.223", user: "s" },
    llmPorts: [8888],
    hermesMonitoring: true,
  });
  assert.equal(spark.platform, "darwin");
  assert.equal(spark.kind, "host");
  assert.equal(spark.isLocal, false);
  assert.deepEqual(spark.llmPorts, [8888]);
  assert.equal(spark.hermesMonitoring, true); // Hermes checks stay available on macOS
});

test("GPU/CPU power of exactly 0 counts as unavailable, a real reading stays available", async () => {
  const withPower = JSON.parse(SAMPLE);
  withPower.cpu_power = 4.2;
  withPower.gpu_power = 2.5;
  const out = ["__UPTIME__", "{ sec = 1728850000 }", "__MACMON__", JSON.stringify(withPower)].join("\n");
  const c = macCollector();
  c._macRun = async () => out;
  const gpu = await c.collectGpu();
  assert.equal(gpu.power.draw, 2.5);
  assert.equal(gpu.metricAvailability.powerDraw, true);
  const cpu = await c.collectCpu();
  assert.equal(cpu.draw, 4.2);
  // A literal 0 is "counter unmeasured" (macmon's CLPC docs), never a 0 W GPU.
  const broken = JSON.parse(SAMPLE);
  broken.gpu_power = 0;
  const c2 = macCollector();
  c2._macRun = async () => ["__UPTIME__", "{ sec = 1728850000 }", "__MACMON__", JSON.stringify(broken)].join("\n");
  const gpu2 = await c2.collectGpu();
  assert.equal(gpu2.power.draw, 0);
  assert.equal(gpu2.metricAvailability.powerDraw, false);
});

test("an unfinished macmon call is reused however old, a finished one only for ~1.2 s", () => {
  const c = new SystemCollector({ id: "m", platform: "darwin", kind: "host", isLocal: false, ssh: { host: "10.0.0.5", user: "me" } });
  const pending = Promise.resolve("pending");
  c._macCache = new Map([["metrics", { at: Date.now() - 60_000, settled: false, promise: pending }]]);
  assert.equal(c._macRun("metrics", "x"), pending);
  const done = Promise.resolve("done");
  c._macCache = new Map([["metrics", { at: Date.now() - 100, settled: true, promise: done }]]);
  assert.equal(c._macRun("metrics", "x"), done);
});
