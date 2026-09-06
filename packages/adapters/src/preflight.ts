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
for (const [i, name] of ['bridge.mjs', 'reprove-codex'].entries()) {
  const bytes = fs.readFileSync('/opt/reprove/codex/' + name);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== process.argv[i + 1]) throw Error('runtime entry changed');
}
const digest = crypto.createHash('sha256');
const root = '/opt/reprove/codex';
const walk = relative => {
  const absolute = path.join(root, relative), st = fs.lstatSync(absolute);
  if (st.uid !== 0) throw Error('runtime is not immutable');
  digest.update(relative).update('\\0').update(String(st.mode)).update('\\0');
  if (st.isSymbolicLink()) {
    const target = fs.realpathSync(absolute);
    if (!target.startsWith(root + '/')) throw Error('runtime link escapes');
    digest.update(fs.readlinkSync(absolute));
  } else if (st.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative,name));
  } else if (st.isFile()) {
    const fd = fs.openSync(absolute, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let count; while ((count = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
  } else throw Error('unsupported runtime entry');
  digest.update('\\0');
};
walk('');
process.stdout.write(digest.digest('hex'));

for (const p of ['/reprove/runtime/.harness-bootstrap','/reprove/home/.codex']) fs.mkdirSync(p,{recursive:true,mode:0o700});
const bootstrap = '/reprove/runtime/.harness-bootstrap/codex';
try { fs.symlinkSync('/opt/reprove/codex',bootstrap); } catch(e) { if(e.code !== 'EEXIST') throw e; }
if (fs.realpathSync(bootstrap) !== '/opt/reprove/codex') throw Error('bootstrap redirected');
`;

/** Trusted pre-execution checks; no repository command or credential runs here. */
export const checkCodexSandbox = async (
  request: Pick<PassRequest, "sandbox" | "signal">
): Promise<string | null> => {
  const { access } = request.sandbox;
  if (!access?.streaming) {
    return null;
  }
  try {
    const files = await codexImageFiles();
    const bridge = files.find((file) => file.path === "bridge.mjs");
    const launcher = files.find((file) => file.path === "reprove-codex");
    if (!bridge || !launcher) {
      return null;
    }
    const digest = createHash("sha256").update(bridge.content).digest("hex");
    const prepared = await execute(
      access,
      [
        "node",
        "-e",
        PREPARE,
        digest,
        createHash("sha256").update(launcher.content).digest("hex"),
      ],
      CODEX_ENVIRONMENT,
      request.signal,
      request.sandbox.workspace.path
    );
    if (prepared.exitCode !== 0) {
      return null;
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
    return version.exitCode === 0 &&
      version.stdout.trim() === "codex-cli 0.149.1" &&
      /^[a-f0-9]{64}$/u.test(prepared.stdout)
      ? prepared.stdout
      : null;
  } catch {
    return null;
  }
};
