// PROTOTYPE for #135, reused by #137. Host-side, as root: which processes carry the bridge token, without printing it.
// usage: node scan.mjs <bridge-pid>
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (pid, file) => { try { return readFileSync(`/proc/${pid}/${file}`, "latin1"); } catch { return null; } };
const bridgeEnv = read(process.argv[2], "environ");
const token = bridgeEnv?.split("\0").find((e) => e.startsWith("BRIDGE_CHANNEL_TOKEN="))?.slice("BRIDGE_CHANNEL_TOKEN=".length);
if (!token) { console.log(JSON.stringify({ error: "no token in the bridge environ" })); process.exit(2); }
const processes = [];
for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
  const status = read(pid, "status");
  const cmdline = read(pid, "cmdline");
  if (!status || !cmdline) continue; // gone, or a kernel thread
  const field = (key) => status.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"))?.[1];
  const environ = read(pid, "environ");
  processes.push({
    pid: Number(pid), ppid: Number(field("PPid")), uid: Number(field("Uid")), uids: status.match(/^Uid:\s*(.*)$/m)?.[1].trim().split(/\s+/).join("/"), noNewPrivs: Number(field("NoNewPrivs")),
    comm: (read(pid, "comm") ?? "").trim(), argv: cmdline.split("\0").slice(0, 3).map((a) => a.slice(0, 60)).join(" "),
    tokenInCmdline: cmdline.includes(token),
    tokenInEnviron: environ === null ? null : environ.includes(token),
    bridgeVarNames: environ === null ? null : environ.split("\0").filter((e) => e.startsWith("BRIDGE_")).map((e) => e.split("=")[0]),
  });
}
console.log(JSON.stringify({ tokenSha8: createHash("sha256").update(token).digest("hex").slice(0, 8), tokenLength: token.length, processes }));
