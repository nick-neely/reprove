/** Portable I/O supplied by the Worker for its already attested Sandbox. */
export interface SandboxConnection {
  readonly streaming: boolean;
  readonly start: (
    command: readonly string[],
    options?: {
      readonly directory?: string;
      readonly environment?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    }
  ) => {
    readonly stdin: WritableStream<Uint8Array>;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly wait: () => Promise<{ readonly exitCode: number }>;
    readonly kill: () => Promise<void>;
  };
  readonly read: (path: string) => Promise<Uint8Array | null>;
  readonly write: (path: string, content: Uint8Array) => Promise<void>;
  readonly exposePort: (
    port: number
  ) => Promise<{ readonly url: string; readonly close: () => Promise<void> }>;
  readonly openProxy: (options: {
    readonly rules: readonly {
      readonly origin: string;
      readonly method: string;
      readonly path: string;
    }[];
    readonly maxRequests: number;
    readonly maxConcurrency: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly signal: AbortSignal;
    readonly fetch?: (request: Request) => Promise<Response>;
  }) => Promise<{
    readonly environment: Readonly<Record<string, string>>;
    readonly credentials: (
      credentials: readonly {
        readonly origin: string;
        readonly placeholder: string;
        readonly secret: string;
      }[]
    ) => void;
    readonly close: () => Promise<void>;
  }>;
}
