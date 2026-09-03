<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/worker-core

## dist/index.d.ts

```ts
export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";
export declare const packageName: "@reprove/worker-core";
/**
 * Shell. Exercising all three permitted edges through their package exports
 * makes ADR 0010's matrix row a compiled fact rather than a declaration.
 */
export declare const composedFrom: {
    readonly adapters: "@reprove/adapters";
    readonly protocolVersion: 1;
    readonly sandboxContainer: "@reprove/sandbox-container";
};
```
