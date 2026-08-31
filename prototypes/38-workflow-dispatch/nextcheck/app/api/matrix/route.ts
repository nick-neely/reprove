import { start } from 'workflow/api';
import { read, inject } from '../../../probe/instance.ts';
import { matrixWorkflow } from '../../../workflows/matrix.ts';

export const dynamic = 'force-dynamic';

export async function POST() {
  inject('set-by-caller');
  const caller = read();
  const run = await start(matrixWorkflow, []);
  const out = (await run.returnValue) as any;
  return Response.json({
    builder: 'next-turbopack',
    caller,
    ...out,
    staticEqCaller: out.viaStatic.instance === caller.instance,
    dynamicEqCaller: out.viaDynamic.instance === caller.instance,
    staticEqDynamic: out.viaStatic.instance === out.viaDynamic.instance,
  });
}
