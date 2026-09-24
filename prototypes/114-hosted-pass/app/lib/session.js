// PROTOTYPE for #114. Throwaway, never merged.
// A HarnessV1NetworkSandboxSession over @vercel/sandbox. It counts spawns, so a
// resumed Slice that re-spawns the bridge (replay or rerun) is visible.
const BRIDGE_PORT = 3000;

function streamsOf(command) {
  let out, err;
  const stdout = new ReadableStream({ start: (c) => { out = c; } });
  const stderr = new ReadableStream({ start: (c) => { err = c; } });
  (async () => {
    try {
      for await (const line of command.logs()) {
        (line.stream === "stderr" ? err : out).enqueue(new TextEncoder().encode(line.data));
      }
    } catch { /* stream ends with the command or the process */ }
    try { out.close(); } catch {}
    try { err.close(); } catch {}
  })();
  return { stdout, stderr };
}

export function vercelSession(sandbox, { workDir = "/vercel/sandbox", onRequestTransformations, trace = () => {} } = {}) {
  const counters = { spawns: 0, runs: 0, transformCalls: 0 };
  const read = async (path) => {
    const buffer = await sandbox.readFileToBuffer({ path });
    return buffer ? new Uint8Array(buffer) : null;
  };
  const write = (path, bytes) => sandbox.writeFiles([{ path, content: Buffer.from(bytes) }]);
  const io = {
    id: sandbox.name,
    description: "Reprove prototype Vercel Sandbox",
    defaultWorkingDirectory: workDir,
    ports: [BRIDGE_PORT],
    getPortUrl: async ({ port }) => sandbox.domain(port),
    getPortEndpoint: async ({ port, protocol }) => {
      const url = sandbox.domain(port);
      return { url: protocol === "ws" ? url.replace(/^https:/, "wss:") : url };
    },
    stop: async () => {},
    destroy: async () => {},
    readBinaryFile: ({ path }) => read(path),
    readFile: async ({ path }) => {
      const bytes = await read(path);
      return bytes === null ? null : new Response(bytes).body;
    },
    readTextFile: async ({ path, startLine, endLine }) => {
      const bytes = await read(path);
      if (bytes === null) return null;
      const text = new TextDecoder().decode(bytes);
      return startLine !== undefined || endLine !== undefined
        ? text.split("\n").slice((startLine ?? 1) - 1, endLine).join("\n")
        : text;
    },
    writeBinaryFile: ({ path, content }) => write(path, content),
    writeTextFile: ({ path, content }) => write(path, new TextEncoder().encode(content)),
    writeFile: async ({ path, content }) => write(path, new Uint8Array(await new Response(content).arrayBuffer())),
    run: async ({ command, workingDirectory, env }) => {
      counters.runs++;
      trace("run", command.slice(0, 160));
      const done = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd: workingDirectory ?? workDir, env });
      return { exitCode: done.exitCode ?? -1, stdout: await done.stdout(), stderr: await done.stderr() };
    },
    spawn: async ({ command, workingDirectory, env }) => {
      counters.spawns++;
      trace("spawn", command.slice(0, 160));
      const cmd = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd: workingDirectory ?? workDir, env, detached: true });
      const { stdout, stderr } = streamsOf(cmd);
      return {
        stdout, stderr,
        wait: async () => ({ exitCode: (await cmd.wait()).exitCode ?? -1 }),
        kill: async () => { trace("kill", cmd.cmdId); await cmd.kill().catch(() => {}); },
      };
    },
    addRequestTransformations: async (entries) => {
      counters.transformCalls++;
      trace("addRequestTransformations", entries.map((e) => ({ match: e.match, headers: Object.keys(e.transform.headers) })));
      await onRequestTransformations?.(entries);
    },
  };
  io.restricted = () => ({
    description: io.description,
    readFile: io.readFile, readBinaryFile: io.readBinaryFile, readTextFile: io.readTextFile,
    writeFile: io.writeFile, writeBinaryFile: io.writeBinaryFile, writeTextFile: io.writeTextFile,
    run: io.run, spawn: io.spawn,
  });
  return { io, counters };
}
