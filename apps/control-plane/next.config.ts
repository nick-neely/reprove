import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // ADR 0010 keeps the packages in source form in the workspace; Next compiles
  // them from `dist` like any other dependency, so nothing is transpiled here.

  // The Postgres driver stays a Node module rather than being compiled into
  // the route chunks: it probes for an optional native binding at load, and
  // externalizing it is what puts it - and its own dependencies - into the
  // output file trace, where ADR 0014's build gate asserts it is.
  serverExternalPackages: ["pg"],

  // ADR 0017 makes `@reprove/control-plane`'s `drizzle/` folder a runtime
  // asset: the boot assertion joins the hashes Drizzle stored against the
  // committed files that produced them, read from the folder beside the
  // module at run time. File tracing follows imports and cannot see a
  // `readFileSync`, so the folder is named here for every route that composes
  // the control plane - the webhook, and the step route the World drives.
  outputFileTracingIncludes: {
    "/api/github/webhook": ["../../packages/control-plane/drizzle/**"],
    "/.well-known/workflow/v1/step": [
      "../../packages/control-plane/drizzle/**",
    ],
  },
};

/**
 * `withWorkflow` is what makes this app the composition of the orchestration
 * seam (ADR 0014): it discovers every `'use workflow'` and `'use step'`
 * function reachable from the app's routes - which is
 * `@reprove/control-plane-workflow`, followed because that package declares
 * `workflow` - compiles them, and generates the `/.well-known/workflow/v1/*`
 * routes the World drives them through. Without it the webhook route would
 * still build, and `start()` would fail at the first delivery.
 *
 * Which World runs them is deployment configuration, read by the SDK itself:
 * `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` with `WORKFLOW_POSTGRES_URL`
 * for a deployment, and `WORKFLOW_LOCAL_BASE_URL` naming this app's own origin
 * so the World's queue can reach the routes above. Left unset, the SDK runs the
 * local file-backed World under `.next/workflow-data`, which is a development
 * convenience and not something a deployment should run on.
 */
export default withWorkflow(nextConfig);
