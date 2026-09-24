import { fileURLToPath } from "node:url";

const adapters = (dist) =>
  new URL(`../../packages/adapters/${dist}/index.js`, import.meta.url).href;

/** Two Adapter builds differing only in the frozen bootstrap lock. */
export const VARIANTS = {
  "0.153.4": {
    cli: "0.153.4",
    adapters: adapters("dist"),
    image: "reprove-codex-131:0.153.4-1.0.104",
  },
  "0.156.1": {
    cli: "0.156.1",
    // packages/adapters built with bootstrap-0.156.1.patch applied, copied to dist-0156.
    adapters: adapters("dist-0156"),
    image: "reprove-codex-131:0.156.1-1.0.104",
  },
};

export const OUT = fileURLToPath(new URL("./out/", import.meta.url));
