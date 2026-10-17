/**
 * Live end-to-end check: run the real SystemCollector mac path against minim6
 * over SSH (key auth baked in on airm5). Read-only — no models are touched.
 * Run: node server/collectors/__tests__/live-minim6.mjs
 */
import { SystemCollector, collectionWasSuccessful } from "../SystemCollector.js";

const spark = {
  id: "minim6",
  name: "minim6",
  kind: "host",
  platform: "darwin",
  isLocal: false,
  lanIp: "192.168.1.223",
  ssh: { host: "192.168.1.223", user: "s", auth: "key", port: 22 },
  llmPorts: [8888],
};

const c = new SystemCollector(spark);

const gpu = await c.collectGpu();
console.log("GPU:", JSON.stringify({ temp: gpu.temperature, usage: gpu.usage, power: gpu.power, availability: gpu.metricAvailability, device: gpu.gpus[0]?.name }, null, 1));
console.log("GPU successful:", collectionWasSuccessful(gpu));

const cpu = await c.collectCpu();
console.log("CPU:", JSON.stringify(cpu));

const ram = await c.collectRam();
console.log("RAM:", JSON.stringify(ram));

const hw = await c.detectMacHardware();
console.log("Hardware:", JSON.stringify(hw));

const up = await c.readMacUptime();
console.log("Uptime sec:", up, `(${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h)`);

const storage = await c.collectStorage();
console.log("Storage:", JSON.stringify(storage.map((d) => ({ device: d.device, total: d.total, pct: d.percentage }))));

const net = await c.collectNetwork();
console.log("Network:", JSON.stringify({ primary: net.primaryInterface, link: net.linkSpeedMbps, ifaces: net.interfaces.map((i) => i.name) }));
