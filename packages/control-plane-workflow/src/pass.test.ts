/**
 * The seam this package decides rather than `@reprove/worker-hosted`: whether a
 * hosted placement is composed at all, and what an install that is not simply
 * absent counts as.
 *
 * Neither needs a database or a durable runtime. What the pass *does* is
 * `spine.test.ts`'s subject, against the real World and the real control plane,
 * and how `dispatchHostedPass` wires one is `dispatch.test.ts`'s.
 */
import { describe, expect, it } from "vitest";

import { composeHostedPlacement } from "./placement.js";

const DRIVER = "@reprove/worker-hosted";

/** Node's own error for a package that is not installed. */
const notInstalled = (specifier: string): Error =>
  Object.assign(
    new Error(
      `Cannot find package '${specifier}' imported from /app/composition.js`
    ),
    { code: "ERR_MODULE_NOT_FOUND" }
  );

describe("the hosted composition seam", () => {
  it("composes no hosted dispatch when the hosted driver is not installed", async () => {
    // ADR 0010's self-hosted deployment: `control-plane` +
    // `control-plane-workflow`, and no harness code anywhere. The import has to
    // answer rather than throw, or that deployment has no control plane at all.
    await expect(
      composeHostedPlacement(() => Promise.reject(notInstalled(DRIVER)))
    ).resolves.toBeNull();
  });

  it("reports a hosted driver that is installed and broken rather than hiding it", async () => {
    // Answering `null` here would report a defective deployment as a
    // self-hosted one, which is the one wrong answer available.
    await expect(
      composeHostedPlacement(() =>
        Promise.reject(new SyntaxError("Unexpected token"))
      )
    ).rejects.toThrow("Unexpected token");
  });

  it("reports a hosted driver whose own dependency is missing", async () => {
    // The same wrong answer, reached by the route a bare `code` check cannot
    // see: the driver is installed and one of *its* imports does not resolve,
    // so Node raises `ERR_MODULE_NOT_FOUND` for a specifier that is not the
    // driver. Reading the code alone would call that broken install a
    // self-hosted deployment.
    await expect(
      composeHostedPlacement(() =>
        Promise.reject(notInstalled("@reprove/worker-core"))
      )
    ).rejects.toThrow("@reprove/worker-core");
  });

  it("reports a resolution failure it cannot attribute", async () => {
    // A phrasing this does not recognize is not evidence of absence. An
    // unexplained failure is a defect to surface rather than a deployment shape
    // to infer.
    await expect(
      composeHostedPlacement(() =>
        Promise.reject(
          Object.assign(new Error("the loader gave up"), {
            code: "ERR_MODULE_NOT_FOUND",
          })
        )
      )
    ).rejects.toThrow("the loader gave up");
  });

  it("composes what the package exports when it is installed", async () => {
    const placement = await composeHostedPlacement(
      () => import("@reprove/worker-hosted")
    );

    expect(placement).toMatchObject({
      createPhase0WorkerCore: expect.any(Function),
      dispatchHostedRun: expect.any(Function),
      phase0RunInput: expect.any(Function),
      runHostedPlacement: expect.any(Function),
    });
  });
});
