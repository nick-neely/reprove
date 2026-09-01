#!/usr/bin/env node
import { packageName } from "./index.js";

// Shell. `bootstrap` and `migrate` arrive with the persistence issue. The
// command is namespaced deliberately: two global bins named `reprove` collide.
process.stdout.write(
  `${packageName}\nusage: reprove-control-plane <bootstrap|migrate>\nNot implemented yet.\n`
);
