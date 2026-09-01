#!/usr/bin/env node
import { packageName } from "./index.js";

// Shell. `enroll`, `start` and `status` arrive with the Worker lifecycle issue.
process.stdout.write(
  `${packageName}\nusage: reprove <enroll|start|status>\nNot implemented yet.\n`
);
