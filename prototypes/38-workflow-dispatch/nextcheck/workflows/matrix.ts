// Same 2x2 as prototypes/38-workflow-dispatch/probe/matrix.ts, under the real
// Next.js/Turbopack builder.
import { read } from '../probe/instance.ts';

export async function matrixWorkflow() {
  'use workflow';
  const viaStatic = await staticStep();
  const viaDynamic = await dynamicStep();
  return { viaStatic, viaDynamic };
}

async function staticStep() {
  'use step';
  return read();
}

async function dynamicStep() {
  'use step';
  const m = await import('../probe/instance.ts');
  return m.read();
}
