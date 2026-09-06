import { once } from "node:events";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import type { SandboxAccess } from "./access.js";
import { boundPort } from "./tcp.js";

export interface PortEndpoint {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const CONNECT = `const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[1])});socket.on('error',()=>process.exit(1));process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('close',()=>process.exit(0))`;

/** Reach one loopback port without giving the Sandbox a network interface. */
export const exposePort = async (
  start: SandboxAccess["start"],
  port: number
): Promise<PortEndpoint> => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("a Sandbox port must be between 1 and 65535");
  }
  const sockets = new Set<Socket>();
  const serve = async (socket: Socket) => {
    sockets.add(socket);
    let process: ReturnType<SandboxAccess["start"]> | undefined;
    try {
      process = start(["node", "-e", CONNECT, String(port)]);
      await Promise.all([
        pipeline(socket, Writable.fromWeb(process.stdin)),
        pipeline(Readable.fromWeb(process.stdout), socket),
        process.wait(),
      ]);
    } catch {
      socket.destroy();
    } finally {
      try {
        await process?.kill();
      } catch {
        socket.destroy();
      }
      sockets.delete(socket);
    }
  };
  const server = createServer((socket) => {
    void serve(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const portNumber = boundPort(server);
  return {
    url: `http://127.0.0.1:${portNumber}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await promisify(server.close.bind(server))();
      }
    },
  };
};
