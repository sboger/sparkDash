/**
 * macOS network collection. BSD has no /proc/net/dev, and `ifconfig` carries no
 * byte counters, so one round trip reads the default route plus `netstat -ibn`:
 * the <Link#n> row per interface holds cumulative Ibytes/Obytes, the inet rows
 * hold the addresses.
 */

/** Default route + per-interface counters in one SSH round trip. */
export const MAC_NETWORK_CMD = [
  "echo __ROUTE__",
  "route -n get default 2>/dev/null",
  "echo __NETSTAT__",
  "netstat -ibn 2>/dev/null",
].join("\n");

/** Interface families that never carry the dashboard's traffic. */
const MAC_VIRTUAL_IFACE = /^(utun|bridge|awdl|llw|anpi|ap1|lo0|gif|stf|demux|ipsec|pflog|vmenet|nan)/;

/**
 * @param {string} output MAC_NETWORK_CMD output
 * @returns {{ primaryInterface: string|null, interfaces: Array<{name:string, rxBytes:number, txBytes:number, ip:string|null, operstate:string}> }}
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

  const counters = new Map();
  const ips = new Map();
  for (const line of netPart.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7 || parts[0] === "Name") continue;
    // netstat marks a down interface with a trailing "*" (e.g. "nan0*").
    const name = parts[0].replace(/\*$/, "");
    if (MAC_VIRTUAL_IFACE.test(name)) continue;
    if (/^<Link/.test(parts[2] || "")) {
      // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]
      counters.set(name, {
        rxBytes: parseInt(parts[6], 10) || 0,
        txBytes: parseInt(parts[9], 10) || 0,
      });
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(parts[3] || "") && !ips.has(name)) {
      ips.set(name, parts[3]);
    }
  }

  const interfaces = Array.from(counters.entries()).map(([name, c]) => ({
    name,
    rxBytes: c.rxBytes,
    txBytes: c.txBytes,
    ip: ips.get(name) ?? null,
    operstate: /^(en|eth)/.test(name) ? "up" : "unknown",
  }));
  return { primaryInterface, interfaces };
}
