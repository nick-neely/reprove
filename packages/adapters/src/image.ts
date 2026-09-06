import { createCodex } from "@ai-sdk/harness-codex";

import { CODEX_BOOTSTRAP_FILES } from "./bootstrap.js";

/** Trusted build inputs, resolved from the exactly pinned Harness artifact. */
export interface ImageFile {
  readonly path: string;
  readonly content: string;
}

const suppressDiscovery = (file: ImageFile): ImageFile => {
  if (file.path !== "bridge.mjs") {
    return file;
  }
  const constructor = "new codexSdk.Codex({";
  if (file.content.split(constructor).length !== 2) {
    throw new Error(
      "the pinned bridge constructor changed; review suppression before building"
    );
  }
  // The upstream SDK has a path override but no ignore-config/rules options.
  // Keep this one insertion explicit, bounded and covered by executable canaries.
  return {
    ...file,
    content: file.content.replace(
      constructor,
      `${constructor}\n    codexPathOverride: '/opt/reprove/codex/reprove-codex',`
    ),
  };
};

/** Build once, before any repository or credential exists in the Sandbox. */
export const codexImageFiles = async (): Promise<readonly ImageFile[]> => {
  const recipe = await createCodex().getBootstrap?.();
  if (!recipe) {
    throw new Error("the pinned Codex Harness supplied no bootstrap recipe");
  }
  return [
    ...CODEX_BOOTSTRAP_FILES,
    ...recipe.files
      .filter((file) => file.path === `${recipe.bootstrapDir}/bridge.mjs`)
      .map((file) =>
        suppressDiscovery({
          path: file.path.slice(recipe.bootstrapDir.length + 1),
          content: file.content,
        })
      ),
    {
      path: "reprove-codex",
      content:
        '#!/bin/sh\nexec /opt/reprove/codex/node_modules/.pnpm/node_modules/.bin/codex "$@" --ignore-user-config --ignore-rules\n',
    },
    {
      path: "Dockerfile",
      content: `FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /opt/reprove/codex
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY bridge.mjs reprove-codex ./
RUN chmod 555 reprove-codex
RUN mkdir -p /reprove/workspace /reprove/input && chmod 755 /reprove /reprove/workspace /reprove/input
ENV PATH="/opt/reprove/codex/node_modules/.pnpm/node_modules/.bin:$PATH"
WORKDIR /reprove/workspace
CMD ["node", "-e", "setInterval(()=>{},2147483647)"]
`,
    },
  ];
};
