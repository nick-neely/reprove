import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { z } from "zod";

import type { SandboxAccess } from "./access.js";
import { createHostProxy } from "./proxy.js";
import type { ProxyCredential, ProxyOptions } from "./proxy.js";

export interface SandboxProxy {
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials: (credentials: readonly ProxyCredential[]) => void;
  readonly close: () => Promise<void>;
}

// Only loopback exists in this namespace. Raw proxy connections travel over the
// attached process's pipes; no host IP, runtime socket, or direct egress is added.
const RELAY = `
const net=require('node:net'),readline=require('node:readline');
const sockets=new Map();let next=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const server=net.createServer(socket=>{
 if(sockets.size>=16){socket.destroy();return}
 const id=++next;sockets.set(id,socket);send({id,open:true});
 socket.on('data',data=>{socket.pause();process.stdout.write(JSON.stringify({id,data:data.toString('base64')})+'\\n',()=>socket.resume())});
 socket.on('end',()=>send({id,end:true}));
 socket.on('error',()=>{});
 socket.on('close',()=>{sockets.delete(id);send({id,close:true})});
});
server.listen(0,'127.0.0.1',()=>send({ready:server.address().port}));
readline.createInterface({input:process.stdin}).on('line',line=>{
 if(line.length>262144)process.exit(1);
 const m=JSON.parse(line),socket=sockets.get(m.id);if(!socket)return;
 if(typeof m.data==='string')socket.write(Buffer.from(m.data,'base64'));
 if(m.end)socket.end();if(m.close)socket.destroy();
}).on('close',()=>process.exit(0));
`;

const frameSchema = z
  .object({
    ready: z.number().int().min(1).max(65_535).optional(),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
      .optional(),
    open: z.literal(true).optional(),
    end: z.literal(true).optional(),
    close: z.literal(true).optional(),
  })
  .strict()
  .refine((frame) => {
    const actions = [frame.data, frame.open, frame.end, frame.close].filter(
      (value) => value !== undefined
    ).length;
    return frame.ready === undefined
      ? frame.id !== undefined && actions === 1
      : frame.id === undefined && actions === 0;
  });
type Frame = z.infer<typeof frameSchema>;

export const openSandboxProxy = async (
  access: SandboxAccess,
  options: ProxyOptions
): Promise<SandboxProxy> => {
  const host = await createHostProxy(options);
  const certificatePath = "/tmp/reprove-proxy-ca.pem";
  try {
    await access.write(certificatePath, host.certificate);
  } catch (error) {
    await host.close();
    throw error;
  }
  let process: ReturnType<SandboxAccess["start"]>;
  try {
    process = access.start(["node", "-e", RELAY], { signal: options.signal });
  } catch (error) {
    await host.close();
    throw error;
  }
  const writer = process.stdin.getWriter();
  const sockets = new Map<number, Socket>();
  const ready = Promise.withResolvers<number>();
  let closing: Promise<void> | undefined;
  const send = async (frame: Frame) => {
    try {
      await writer.write(
        new TextEncoder().encode(`${JSON.stringify(frame)}\n`)
      );
    } catch {
      for (const socket of sockets.values()) {
        socket.destroy();
      }
    }
  };
  const close = () => {
    const release = async () => {
      for (const socket of sockets.values()) {
        socket.destroy();
      }
      try {
        await process.kill();
      } finally {
        await host.close();
      }
    };
    closing ??= release();
    return closing;
  };
  const receive = async () => {
    const input = Readable.fromWeb(process.stdout);
    // Bound bytes before readline can buffer an attacker-controlled line.
    let lineBytes = 0;
    input.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > 262_144) {
          input.destroy(new Error("proxy frame too large"));
        }
      }
    });
    try {
      for await (const line of createInterface({
        input,
        crlfDelay: Infinity,
      })) {
        if (line.length > 262_144) {
          throw new Error("proxy frame too large");
        }
        const frame = frameSchema.parse(JSON.parse(line));
        if (frame.ready !== undefined) {
          ready.resolve(frame.ready);
          continue;
        }
        if (frame.id === undefined) {
          throw new Error("missing proxy connection id");
        }
        const { id } = frame;
        if (frame.open === true) {
          if (sockets.has(id) || sockets.size >= 16) {
            throw new Error("proxy connection limit exceeded");
          }
          const socket = connect({ host: "127.0.0.1", port: host.port });
          sockets.set(id, socket);
          socket.on("data", (data: Buffer) => {
            socket.pause();
            const forward = async () => {
              await send({ id, data: data.toString("base64") });
              socket.resume();
            };
            void forward();
          });
          socket.on("end", () => {
            void send({ id, end: true });
          });
          socket.on("error", () => socket.destroy());
          socket.on("close", () => {
            sockets.delete(id);
            void send({ id, close: true });
          });
        }
        const socket = sockets.get(id);
        if (!socket) {
          continue;
        }
        if (
          frame.data !== undefined &&
          !socket.write(Buffer.from(frame.data, "base64"))
        ) {
          await once(socket, "drain", { signal: options.signal });
        }
        if (frame.end === true) {
          socket.end();
        }
        if (frame.close === true) {
          socket.destroy();
        }
      }
      ready.reject(new Error("Sandbox proxy closed before readiness"));
    } catch (error) {
      ready.reject(error);
    } finally {
      try {
        await close();
      } catch {
        ready.reject(new Error("Sandbox proxy cleanup failed"));
      }
    }
  };
  void receive();
  const drain = async () => {
    try {
      for await (const chunk of process.stderr) {
        void chunk;
      }
    } catch {
      ready.reject(new Error("Sandbox proxy process failed"));
    }
  };
  void drain();
  let port: number;
  try {
    port = await ready.promise;
  } catch (error) {
    await close();
    throw error;
  }
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    environment: {
      HTTP_PROXY: endpoint,
      HTTPS_PROXY: endpoint,
      http_proxy: endpoint,
      https_proxy: endpoint,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      SSL_CERT_FILE: certificatePath,
      NODE_EXTRA_CA_CERTS: certificatePath,
    },
    credentials: host.credentials,
    close,
  };
};
