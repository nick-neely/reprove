<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/adapters

## dist/index.d.ts

```ts
/**
 * Shell. `@reprove/adapters` may not depend on `@reprove/protocol`: an Adapter
 * yields the unnamed per-Pass bundle and `@reprove/worker-core` composes the
 * wire Result, so an Adapter that knew the wire format would be reaching a
 * layer above itself (ADR 0005, ADR 0010).
 */
export declare const packageName: "@reprove/adapters";
```
