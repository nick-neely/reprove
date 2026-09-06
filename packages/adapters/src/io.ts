import type { SandboxConnection } from "./connection.js";

export const readBytes = async (
  stream: ReadableStream<Uint8Array>,
  limit = 4 * 1024 * 1024
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error("Codex stream exceeds the Pass limit");
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

export const readText = async (
  stream: ReadableStream<Uint8Array>,
  limit?: number
): Promise<string> => new TextDecoder().decode(await readBytes(stream, limit));

export const execute = async (
  access: SandboxConnection,
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  directory?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const process = access.start(command, { environment, signal, directory });
  try {
    await process.stdin.getWriter().close();
    const [stdout, stderr, status] = await Promise.all([
      readText(process.stdout),
      readText(process.stderr),
      process.wait(),
    ]);
    return { ...status, stdout, stderr };
  } finally {
    await process.kill();
  }
};
