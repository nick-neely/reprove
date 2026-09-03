<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/worker

## dist/bin.d.ts

```ts
#!/usr/bin/env node
export {};
```

## dist/index.d.ts

```ts
export declare const packageName: "@reprove/worker";
/** Shell. The self-hosted lifecycle speaks exactly one protocol version. */
export declare const speaks: {
    readonly protocolVersion: 1;
    readonly workerCore: {
        readonly adapters: "@reprove/adapters";
        readonly protocolVersion: 1;
        readonly sandboxContainer: "@reprove/sandbox-container";
    };
};
```
