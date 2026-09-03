<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/worker-hosted

## dist/index.d.ts

```ts
export declare const packageName: "@reprove/worker-hosted";
/**
 * Shell. The hosted lifecycle is doubly coupled - to the harness SDK through
 * `@reprove/worker-core`, and to Workflow's Vercel World - which is why it is
 * its own package and not a module inside the control plane (ADR 0010).
 */
export declare const drives: {
    readonly protocolVersion: 1;
    readonly workerCore: {
        readonly adapters: "@reprove/adapters";
        readonly protocolVersion: 1;
        readonly sandboxContainer: "@reprove/sandbox-container";
    };
};
```
