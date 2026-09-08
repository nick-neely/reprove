import { packageName as controlPlane } from "@reprove/control-plane";
import { packageName as controlPlaneWorkflow } from "@reprove/control-plane-workflow";
import { HOSTED_WORKER_BUILD_VERSION } from "@reprove/control-plane-workflow/hosted";
import { packageName as workerHosted } from "@reprove/worker-hosted";

// The shell composes the three packages ADR 0010 permits it to depend on, so
// the composition edges are compiled facts rather than intentions.
//
// `@reprove/worker-hosted` is named here and nowhere further in: the
// orchestration package carries it as an *optional peer* and imports it lazily,
// so the composition root is what decides whether a deployment has it (#57).
// This is the hosted one. The self-hosted composition root declares neither it
// nor anything requiring it, and pnpm auto-installs only non-optional peers, so
// that deployment installs no harness code at all.
const composedFrom = [controlPlane, controlPlaneWorkflow, workerHosted];

// The same decision, on the orchestration package's own export map: `./hosted`
// is the half whose declarations name the driver, so importing it is this app
// saying it is the hosted composition - and it is what puts `hostedPass` in the
// module graph the Workflow build discovers workflows from (ADR 0014). A
// self-hosted composition root imports the default subpath alone.
const Page = () => (
  <main>
    <h1>Reprove control plane</h1>
    <ul>
      {composedFrom.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
    <p>Hosted Worker build {HOSTED_WORKER_BUILD_VERSION}</p>
  </main>
);

export default Page;
