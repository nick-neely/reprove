import { Sandbox } from "@vercel/sandbox";
import { vercelCredentials, log, describeError } from "../lib.mjs";
const creds = vercelCredentials();
const [name, ...cmdIds] = process.argv.slice(2);
const s = await Sandbox.get({ ...creds, name });
log("status", s.status);
for (const id of cmdIds) {
  try {
    const c = await s.getCommand(id);
    log(`getCommand ${id}`, c.cmd);
    try { log(`output ${id}`, await c.output("both")); } catch (e) { log(`output ${id} threw`, describeError(e)); }
  } catch (e) { log(`getCommand ${id} threw`, describeError(e)); }
}
