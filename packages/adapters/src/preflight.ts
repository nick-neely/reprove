import { createHash } from "node:crypto";

import { codexImageFiles } from "./image.js";
import { execute } from "./io.js";
import type { PassRequest } from "./types.js";

export const CODEX_ENVIRONMENT = {
  HOME: "/reprove/home",
  CODEX_HOME: "/reprove/home/.codex",
} as const;

const PREPARE = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
if (process.getuid() !== 1000) throw Error('wrong Reviewer identity');
let entries = 0;
const check = p => {
  if (++entries > 1000000) throw Error('Workspace entry limit');
  const st = fs.lstatSync(p);
  if (st.uid !== 0) throw Error('Reviewer could change permissions');
  if (st.isSymbolicLink()) return;
  try { fs.accessSync(p, fs.constants.W_OK); throw Error('writable Workspace'); }
  catch (e) { if (e.code !== 'EACCES' && e.code !== 'EROFS') throw e; }
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) check(path.join(p,name));
};
check(process.cwd());
const bridge = fs.readFileSync('/opt/reprove/codex/bridge.mjs');
if (crypto.createHash('sha256').update(bridge).digest('hex') !== process.argv[1]) throw Error('bridge changed');
for (const p of ['/reprove/runtime/.harness-bootstrap','/reprove/home/.codex']) fs.mkdirSync(p,{recursive:true,mode:0o700});
const bootstrap = '/reprove/runtime/.harness-bootstrap/codex';
try { fs.symlinkSync('/opt/reprove/codex',bootstrap); } catch(e) { if(e.code !== 'EEXIST') throw e; }
if (fs.realpathSync(bootstrap) !== '/opt/reprove/codex') throw Error('bootstrap redirected');
`;

/** Trusted pre-execution checks; no repository command or credential runs here. */
export const checkCodexSandbox = async (
  request: Pick<PassRequest, "sandbox" | "signal">
): Promise<boolean> => {
  const { access } = request.sandbox;
  if (!access?.streaming) {
    return false;
  }
  try {
    const files = await codexImageFiles();
    const bridge = files.find((file) => file.path === "bridge.mjs");
    if (!bridge) {
      return false;
    }
    const digest = createHash("sha256").update(bridge.content).digest("hex");
    const prepared = await execute(
      access,
      ["node", "-e", PREPARE, digest],
      CODEX_ENVIRONMENT,
      request.signal,
      request.sandbox.workspace.path
    );
    if (prepared.exitCode !== 0) {
      return false;
    }
    const version = await execute(
      access,
      [
        "/opt/reprove/codex/node_modules/.pnpm/node_modules/.bin/codex",
        "--version",
      ],
      CODEX_ENVIRONMENT,
      request.signal
    );
    return (
      version.exitCode === 0 && version.stdout.trim() === "codex-cli 0.149.1"
    );
  } catch {
    return false;
  }
};
