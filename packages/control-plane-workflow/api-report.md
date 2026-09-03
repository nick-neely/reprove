<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/control-plane-workflow

## dist/index.d.ts

```ts
export declare const packageName: "@reprove/control-plane-workflow";
/**
 * Shell. A `'use step'` function compiles into a bundle whose module graph is
 * fixed at build time, so the layer that defines steps is the only layer that
 * can configure them - which is why this package exists (ADR 0014).
 */
export declare const orchestrates: {
    readonly controlPlane: "@reprove/control-plane";
    readonly protocolVersion: 1;
};
```
