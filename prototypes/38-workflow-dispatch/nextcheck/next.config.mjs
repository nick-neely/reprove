import { withWorkflow } from 'workflow/next';
export default withWorkflow({
  // The prototype's packages are raw .ts on disk; a published package would ship
  // compiled ESM + .d.ts (ADR 0010). tsc is not what this build is testing.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Deliberately NOT listing the Reprove packages in serverExternalPackages:
  // the builder warns when an externalized package contains workflow code, and
  // whether that warning fires is one of the things this build is checking.
});
