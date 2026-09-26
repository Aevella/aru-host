import { networkInterfaces, hostname } from "node:os";

// Address policy is durable; an interface address is a fresh runtime projection.
export function resolveHostAddress({ mode, fixedURL, port, interfaces, host }) {
  if (mode !== "automatic-lan") return { mode: "fixed", url: fixedURL, status: "configured" };
  interfaces ??= networkInterfaces();
  host ??= hostname();
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter(entry => !entry.internal && entry.family === "IPv4" && isLAN(entry.address))
      .map(entry => ({ name, address: entry.address })))
    .sort((a, b) => Number(/docker|podman|veth|bridge|wsl|vethernet/i.test(a.name))
      - Number(/docker|podman|veth|bridge|wsl|vethernet/i.test(b.name)) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  const address = addresses[0]?.address;
  return { mode, url: address ? `http://${address}:${port}` : `http://${host.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.local:${port}`,
    status: address ? "available" : "no-lan-interface" };
}
function isLAN(address) {
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
