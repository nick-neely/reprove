<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/control-plane

## dist/bin.d.ts

```ts
#!/usr/bin/env node
export {};
```

## dist/index.d.ts

```ts
export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";
export declare const packageName: "@reprove/control-plane";
/**
 * Shell. The control plane validates every Worker submission against the same
 * authoritative schema the Worker emits with, because a hostile or buggy Worker
 * can skip its own code and POST arbitrary bytes (ADR 0010).
 */
export declare const accepts: {
    readonly protocolVersion: 1;
};
```
