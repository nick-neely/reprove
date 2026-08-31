import { start } from 'workflow/api';
// The package-defined workflow, imported by the app: question 1 above.
import { runLifecycle } from '@proto38/control-plane-workflow/workflows';
import { probeComposition } from '../../../workflows/probe.ts';
import { MODULE_INSTANCE } from '../../../config.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json();
  const run = await start(probeComposition, [body.spec, body.ownerId, body.leaseToken]);
  const out = await run.returnValue;
  return Response.json({ caller: MODULE_INSTANCE, packageWorkflow: typeof runLifecycle, ...out });
}
