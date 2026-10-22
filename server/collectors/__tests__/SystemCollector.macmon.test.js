import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { SystemCollector, MACMON_CMD, parseMacmonSample } from "../SystemCollector.js";
import { DARWIN_UPTIME_CMD } from "../../sparks/SparkMonitor.js";

// `macmon pipe -s 1` output captured from a Mac Studio (M3 Ultra, 512 GB, macOS 27), core lists trimmed.
const SAMPLE = '{"all_power":0.0,"ane_power":0.0,"cpu_active_ratio":0.03531907498836517,"cpu_power":0.0,"cpu_scaled_ratio":0.03248313441872597,"cpu_usage_pct":0.123,"ecpu_active_ratio":0.01392458938062191,"ecpu_cores":[{"active_ratio":0.06073359400033951,"core_id":0,"die_id":0,"freq_mhz":1020,"scaled_ratio":0.02412315644323826},{"active_ratio":0.018134476616978645,"core_id":1,"die_id":0,"freq_mhz":1020,"scaled_ratio":0.007202946115285158}],"ecpu_freq_mhz":1020,"ecpu_scaled_ratio":0.005530796013772488,"ecpu_usage":[1020,0.005530796013772488],"fans":[{"max_rpm":3625,"name":"fan0","rpm":1005},{"max_rpm":3625,"name":"fan1","rpm":1006}],"gpu_active_ratio":0.0,"gpu_freq_mhz":0,"gpu_power":0.0,"gpu_ram_power":0.0,"gpu_scaled_ratio":0.0,"gpu_usage":[1398,0.42],"memory":{"ram_total":549755813888,"ram_usage":198868484096,"swap_total":0,"swap_usage":0},"pcpu_active_ratio":0.04245057329535484,"pcpu_cores":[{"active_ratio":0.0,"core_id":0,"die_id":0,"freq_mhz":0,"scaled_ratio":0.0},{"active_ratio":0.0,"core_id":1,"die_id":0,"freq_mhz":0,"scaled_ratio":0.0}],"pcpu_freq_mhz":1092,"pcpu_scaled_ratio":0.041467249393463135,"pcpu_usage":[1092,0.041467249393463135],"ram_power":0.0,"soc":{"chip_name":"Apple M3 Ultra","ecpu_cores":24,"gpu_cores":60,"mac_model":"Mac14,14","memory_gb":512,"pcpu_cores":32},"sys_power":33.5,"temp":{"cpu_temp_avg":39.63,"gpu_temp_avg":36.82},"timestamp":"2026-10-13T20:56:41.464508+00:00"}';

const mac = () => new SystemCollector({ id: "studio", isLocal: false, platform: "darwin", ssh: { host: "studio.local", user: "mon" } });
const withSample = (c, out = SAMPLE) => {
  let calls = 0;
  c._macmonSample = (() => {
    const orig = SystemCollector.prototype._macmonSample;
    return function () { return orig.call(this, async () => { calls += 1; return out; }); };
  })();
  return () => calls;
};

test("parseMacmonSample takes the last JSON line and rejects junk", () => {
  assert.equal(parseMacmonSample(`noise\n${SAMPLE}`).sys_power, 33.5);
  assert.equal(parseMacmonSample("NO_MACMON"), null);
  assert.equal(parseMacmonSample("{not json"), null);
  assert.equal(parseMacmonSample(""), null);
});

test("macOS GPU/CPU/RAM come from one macmon sample", async () => {
  const c = mac();
  const calls = withSample(c);
  const [gpu, cpu, ram, um] = await Promise.all([c.collectGpu(), c.collectCpu(), c.collectRam(), c.collectUnifiedMemory()]);
  assert.equal(calls(), 1, "one SSH round trip shared by all four collectors");
  assert.equal(gpu.vendor, "apple");
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.usage, 42);
  assert.equal(gpu.temperature, 36.8);
  assert.equal(gpu.power.systemDraw, 34);
  assert.equal(gpu.metricAvailability.powerLimit, false);
  assert.equal(cpu.usage, 12);
  assert.equal(cpu.temperature, 39.6);
  assert.equal(cpu.temperatureSource, "macmon");
  assert.equal(ram.total, 524288);
  assert.equal(ram.used, Math.round(198868484096 / 1048576));
  assert.equal(um.total, 524288);
  assert.equal(um.gpuUsed, 0);
});

test("macmon's soc block names the GPU and gives the power bar a nominal scale", async () => {
  const c = mac();
  withSample(c);
  const gpu = await c.collectGpu();
  assert.equal(gpu.gpus[0].name, "Apple M3 Ultra GPU (60 cores)");
  // 60 cores x 2 W = 120 W nominal; the caption still shows "—" for the limit.
  assert.equal(gpu.power.limit, 120);
  assert.equal(gpu.metricAvailability.powerLimit, false);
});

test("an exact 0 W macmon draw reads as unmeasured, a tiny nonzero draw is real", async () => {
  const c = mac();
  withSample(c);
  const idle = await c.collectGpu();
  assert.equal(idle.metricAvailability.powerDraw, false);

  const c2 = mac();
  withSample(c2, SAMPLE.replace('"gpu_power":0.0', '"gpu_power":0.03'));
  const busy = await c2.collectGpu();
  assert.equal(busy.metricAvailability.powerDraw, true);
  assert.equal(busy.power.draw, 0.03);
});

test("macOS without macmon degrades to defaults; RAM falls back to sysctl", async () => {
  const c = mac();
  withSample(c, "NO_MACMON");
  c._getRemoteRamMac = async () => ({ used: 1, total: 2, percentage: 50 });
  const gpu = await c.collectGpu();
  assert.equal(gpu.gpus.length, 0);
  assert.deepEqual(await c.collectRam(), { used: 1, total: 2, percentage: 50 });
  assert.equal((await c.collectCpu()).usage, 0);
});

// Captured from `route -n get default` + `netstat -ibn` on an M6 Mac mini.
const NET_OUT = `__ROUTE__
interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
__NETSTAT__
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        716519     0 1510598482   716519     0 1510598482     0
lo0        16384 127           127.0.0.1         716519     - 1510598482   716519     - 1510598482     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
anpi0      1500  <Link#4>    ea:f8:ac:b3:96:c6        0     0          0        0     0          0     0
en0        1500  <Link#7>    c8:80:6d:41:df:a7  8210327     0 1575950587 13967509     0 10082357663     0
en0        1500  fe80::14a3: fe80:7::14a3:17c3  8210327     - 1575950587 13967509     - 10082357663     -
en0        1500  192.168.1     192.168.1.223    8210327     - 1575950587 13967509     - 10082357663     -
bridge0    1500  <Link#14>   36:d8:f5:89:50:00        0     0          0        0     0          0     0
nan0*      1500  <Link#15>   fe:00:00:00:00:01        0     0          0        0     0          0     0`;

test("macOS network comes from netstat counters and the default route", async () => {
  const { parseMacNetwork, MAC_NETWORK_CMD } = await import("../macMetrics.js");
  const parsed = parseMacNetwork(NET_OUT);
  assert.equal(parsed.primaryInterface, "en0");
  assert.deepEqual(parsed.interfaces.map((i) => i.name), ["en0"], "virtual, loopback and NAN interfaces are skipped");
  assert.equal(parsed.interfaces[0].rxBytes, 1575950587);
  assert.equal(parsed.interfaces[0].txBytes, 10082357663);
  assert.equal(parsed.interfaces[0].ip, "192.168.1.223");
  execFileSync("sh", ["-n", "-c", MAC_NETWORK_CMD]);

  // Speeds are deltas against the previous poll.
  const c = mac();
  c.lastNetworkStats.set("en0", { rxBytes: 1575950587 - 2048, txBytes: 10082357663 - 4096, time: Date.now() - 1000 });
  const net = await c._getRemoteNetworkMac(async () => NET_OUT);
  assert.equal(net.primaryInterface, "en0");
  assert.equal(net.interfaces.length, 1);
  assert.equal(net.interfaces[0].ip, "192.168.1.223");
  assert.equal(net.interfaces[0].operstate, "up");
  assert.ok(net.interfaces[0].rxSpeed > 0 && net.interfaces[0].rxSpeed <= 2100, `rx speed ${net.interfaces[0].rxSpeed}`);
  assert.ok(net.interfaces[0].txSpeed > 0 && net.interfaces[0].txSpeed <= 4200, `tx speed ${net.interfaces[0].txSpeed}`);
  assert.equal(net.linkSpeedMbps, null, "BSD netstat publishes no link speed");
});

test("MACMON_CMD and DARWIN_UPTIME_CMD are valid POSIX sh", () => {
  for (const cmd of [MACMON_CMD, DARWIN_UPTIME_CMD]) execFileSync("sh", ["-n", "-c", cmd]);
  assert.match(MACMON_CMD, /opt\/homebrew\/bin\/macmon/);
  // --soc-info carries the chip name, GPU core count and memory for the header.
  assert.match(MACMON_CMD, /pipe --soc-info/);
  assert.match(MACMON_CMD, /HOME\/\.cargo\/bin\/macmon/);
});

test("DARWIN_UPTIME_CMD parses kern.boottime", () => {
  const fake = DARWIN_UPTIME_CMD.replace("sysctl -n kern.boottime", "echo '{ sec = 1000, usec = 5 } Mon Oct 12 20:07:41 2026'").replace("$(date +%s)", "4600");
  assert.equal(execFileSync("sh", ["-c", fake]).toString().trim(), "3600");
});

test("a Mac without macmon costs one SSH call a minute, not one per poll", async () => {
  const c = mac();
  const calls = withSample(c, "NO_MACMON");
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    for (let i = 0; i < 4; i++) await c.collectGpu();
    await c.collectCpu();
  } finally {
    console.error = orig;
  }
  assert.equal(calls(), 1);
  assert.equal(logged.filter((l) => /macmon/.test(l)).length, 1);
});
