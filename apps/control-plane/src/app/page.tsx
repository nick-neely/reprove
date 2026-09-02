import { packageName as controlPlane } from "@reprove/control-plane";
import { packageName as controlPlaneWorkflow } from "@reprove/control-plane-workflow";
import { packageName as workerHosted } from "@reprove/worker-hosted";

// The shell composes the three packages ADR 0010 permits it to depend on, so
// the composition edges are compiled facts rather than intentions.
const composedFrom = [controlPlane, controlPlaneWorkflow, workerHosted];

const Page = () => (
  <main>
    <h1>Reprove control plane</h1>
    <ul>
      {composedFrom.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  </main>
);

export default Page;
