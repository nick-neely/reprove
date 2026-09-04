/**
 * The container runtime, as the only thing this package touches outside Node.
 *
 * One method: arguments in, text out. Everything security-relevant this package
 * does is expressed as an argument vector, and an argument vector is exactly
 * what a test can inspect - which is what makes "`--privileged` is never
 * rendered" a fact a test can assert rather than a claim a reviewer has to
 * take on faith.
 *
 * It is an injected interface rather than a module the provider imports,
 * because a boundary proven by replacing the module underneath it is proven
 * against a mock of the boundary. Injection is also the only option the house
 * lint rules leave open: module mocking is banned outright.
 */
import type { RuntimeName } from "./request.js";

/** One invocation of the runtime's command-line interface. */
export interface RuntimeInvocation {
  /** The argument vector, without the executable. Never passed to a shell. */
  readonly arguments: readonly string[];
  /** Written to the child's standard input and closed, when present. */
  readonly stdin?: string;
}

/**
 * What the invocation produced. A non-zero exit is an outcome rather than a
 * throw: "the instance does not exist" and "the daemon is unreachable" are
 * different facts, and collapsing both into an exception loses the first.
 */
export interface RuntimeOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ContainerRuntime {
  readonly name: RuntimeName;
  readonly invoke: (invocation: RuntimeInvocation) => Promise<RuntimeOutcome>;
}
