// PROTOTYPE for #114.
import { withWorkflow } from "workflow/next";
export default withWorkflow({
  // A forwarded "/simple/x/" must not get Next's 308: the Sandbox follows it onto the wrong upstream path.
  skipTrailingSlashRedirect: true,
  serverExternalPackages: ["pg", "@ai-sdk/harness", "@ai-sdk/harness-codex"],
  outputFileTracingIncludes: {
    "/.well-known/workflow/v1/step": ["./node_modules/@ai-sdk/harness-codex/dist/bridge/**"],
  },
});
