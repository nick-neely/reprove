import { Sandbox } from "@vercel/sandbox";
import { vercelCredentials, log, ledger } from "../lib.mjs";
const creds = vercelCredentials();
const s = await Sandbox.create({ ...creds, persistent: false, timeout: 180000, networkPolicy: "deny-all", name: `p114-uid-${Date.now().toString(36)}` });
ledger({ kind: "sandbox", name: s.name });
const sh = async (u, c) => { const d = await u.runCommand({ cmd: "sh", args: ["-c", c] }); return (await d.stdout()) + (await d.stderr()); };
try {
  log("before createUser", await sh(s, "stat -c '%n %u:%g %a' /usr/local /usr/local/bin /usr/local/lib; getent passwd 1001 || echo 'no uid 1001'; ls -la /usr/local/bin | head -20; which node npm git; readlink -f $(which node); find / -xdev \\( -uid 1001 -o -gid 1001 \\) 2>/dev/null | grep -v '^/proc' | head -20; find / -xdev -nouser 2>/dev/null | head"));
  const r = await s.createUser("reviewer");
  log("after createUser", await sh(s, "id reviewer; stat -c '%n %U:%G %a' /usr/local/bin; sudo -n sh -c 'echo PATH for root: $PATH; which node'"));
  log("reviewer writes into /usr/local/bin", await sh(r, "echo '#!/bin/sh' > /usr/local/bin/p114-planted && chmod +x /usr/local/bin/p114-planted && ls -la /usr/local/bin/p114-planted; ls -ld /usr/local/lib /usr/local/lib/node_modules 2>&1; [ -w /usr/local/lib/node_modules ] && echo NODE_MODULES_WRITABLE"));
} finally { await s.stop(); }
