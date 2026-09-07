import { readFile } from "node:fs/promises";
import path from "node:path";

/** Read one asset by its request path, e.g. `/css/site.css`. */

const ALLOWED = new Set([".css", ".js", ".png", ".svg"]);

export const readAsset = async (root, requestPath) => {
  const target = path.join(root, requestPath);
  if (!ALLOWED.has(path.extname(target))) {
    throw new Error("unsupported asset type");
  }
  return await readFile(target);
};
