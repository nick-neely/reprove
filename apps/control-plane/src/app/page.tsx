import { packageName as controlPlane } from "@reprove/control-plane";
import { packageName as controlPlaneWorkflow } from "@reprove/control-plane-workflow";

// The shell composes the two packages ADR 0010 permits it to depend on, so the
// composition edges are compiled facts rather than intentions.
//
// `@reprove/worker-hosted` is deliberately absent. It is an optional edge of
// the orchestration package, which imports it lazily and composes no hosted
// dispatch when it is missing (#57), and naming it here would put the harness
// stack back into every deployment's install - including the self-hosted one
// ADR 0010 says omits it.
const composedFrom = [controlPlane, controlPlaneWorkflow];

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
