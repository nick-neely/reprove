import { exposePort } from "./ports.js";
import type { PortEndpoint } from "./ports.js";
import { openSandboxProxy } from "./proxy-relay.js";
import type { SandboxProxy } from "./proxy-relay.js";
import type { ProxyOptions } from "./proxy.js";
import type {
  ContainerRuntime,
  RuntimeProcess,
  RuntimeSpawn,
} from "./runtime.js";

export interface CommandOptions {
  readonly directory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Host-side access to an already attested instance. Commands run as uid 1000. */
export interface SandboxAccess {
  readonly streaming: boolean;
  readonly openProxy: (options: ProxyOptions) => Promise<SandboxProxy>;
  readonly exposePort: (port: number) => Promise<PortEndpoint>;
  readonly close: () => Promise<void>;
  readonly start: (
    command: readonly string[],
    options?: CommandOptions
  ) => RuntimeProcess;
  readonly read: (path: string) => Promise<Uint8Array | null>;
  readonly write: (path: string, content: Uint8Array) => Promise<void>;
  /** Root owns both the file and its parent; the Reviewer cannot replace either. */
  readonly protect: (path: string, content: Uint8Array) => Promise<void>;
}

const READ = `const fs=require('node:fs');try{process.stdout.write(fs.readFileSync(process.argv[1]).toString('base64'))}catch(e){if(e.code==='ENOENT')process.exit(44);throw e}`;
const WRITE = `const fs=require('node:fs'),path=require('node:path');const name=process.argv[1];fs.mkdirSync(path.dirname(name),{recursive:true,mode:0o755});if(process.argv[2]==='protected'){fs.chmodSync('/reprove/input',0o755);for(const p of ['/','/reprove','/reprove/input']){const st=fs.lstatSync(p);if(!st.isDirectory()||st.uid!==0||(st.mode&0o022)!==0)throw Error('unprotected ancestor')}}const fd=fs.openSync(name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{fs.writeSync(fd,Buffer.from(data,'base64'));if(process.argv[2]==='protected')fs.chmodSync(path.dirname(name),0o755);fs.fchmodSync(fd,process.argv[2]==='protected'?0o444:0o600);fs.closeSync(fd)})`;

export const createSandboxAccess = (
  runtime: ContainerRuntime,
  id: string,
  directory: string
): SandboxAccess => {
  let closing: Promise<void> | undefined;
  let closeRequested = false;
  const lifetime = new AbortController();
  const registrations = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (closeRequested) {
      throw new Error("Sandbox access is closed");
    }
  };
  const establish = <T>(setup: Promise<T>, resources: Set<T>): Promise<T> => {
    const registration = Promise.withResolvers<T>();
    registrations.add(registration.promise);
    const complete = async () => {
      try {
        const resource = await setup;
        resources.add(resource);
        assertOpen();
        registration.resolve(resource);
      } catch (error) {
        registration.reject(error);
      } finally {
        registrations.delete(registration.promise);
      }
    };
    void complete();
    return registration.promise;
  };
  const processes = new Set<RuntimeProcess>();
  const endpoints = new Set<PortEndpoint>();
  const proxies = new Set<SandboxProxy>();
  const argumentsFor = (
    command: readonly string[],
    options: CommandOptions = {},
    user = "1000:1000"
  ) => [
    "exec",
    "--interactive",
    "--user",
    user,
    "--workdir",
    options.directory ?? directory,
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new TypeError("invalid environment variable name");
      }
      return ["--env", `${name}=${value}`];
    }),
    "--",
    id,
    ...command,
  ];
  const write = async (
    file: string,
    content: Uint8Array,
    protectedFile: boolean
  ) => {
    assertOpen();
    // Protected inputs have a dedicated root-owned mount. Accepting an arbitrary
    // parent would let a writable directory defeat file permissions by renaming.
    if (protectedFile && !/^\/reprove\/input\/[a-z0-9.-]+$/u.test(file)) {
      throw new TypeError(
        "protected files must be direct children of /reprove/input"
      );
    }
    const result = await runtime.invoke({
      arguments: argumentsFor(
        ["node", "-e", WRITE, file, protectedFile ? "protected" : "private"],
        {},
        protectedFile ? "0:0" : "1000:1000"
      ),
      stdin: Buffer.from(content).toString("base64"),
    });
    if (result.exitCode !== 0) {
      throw new Error("Sandbox file write failed");
    }
  };
  const access: SandboxAccess = {
    openProxy: async (options) => {
      assertOpen();
      return await establish(
        openSandboxProxy(access, {
          ...options,
          signal: AbortSignal.any([options.signal, lifetime.signal]),
        }),
        proxies
      );
    },
    exposePort: async (port) => {
      assertOpen();
      return await establish(exposePort(access.start, port), endpoints);
    },
    close: () => {
      closeRequested = true;
      lifetime.abort();
      const release = async () => {
        await Promise.allSettled(registrations);
        const results = await Promise.allSettled([
          ...[...proxies].map((proxy) => proxy.close()),
          ...[...endpoints].map((endpoint) => endpoint.close()),
          ...[...processes].map((process) => process.kill()),
        ]);
        proxies.clear();
        endpoints.clear();
        processes.clear();
        const errors = results.filter((result) => result.status === "rejected");
        if (errors.length) {
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Sandbox access cleanup failed"
          );
        }
      };
      closing ??= release();
      return closing;
    },
    streaming: runtime.spawn !== undefined,
    start: (command, options) => {
      assertOpen();
      if (!runtime.spawn) {
        throw new Error(
          "the container runtime has no streaming process support"
        );
      }
      const invocation: RuntimeSpawn = options?.signal
        ? { arguments: argumentsFor(command, options), signal: options.signal }
        : { arguments: argumentsFor(command, options) };
      const running = runtime.spawn(invocation);
      processes.add(running);
      return running;
    },
    read: async (file) => {
      assertOpen();
      const result = await runtime.invoke({
        arguments: argumentsFor(["node", "-e", READ, file]),
      });
      if (result.exitCode === 44) {
        return null;
      }
      if (result.exitCode !== 0) {
        throw new Error("Sandbox file read failed");
      }
      return new Uint8Array(Buffer.from(result.stdout, "base64"));
    },
    write: (file, content) => write(file, content, false),
    protect: (file, content) => write(file, content, true),
  };
  return access;
};
