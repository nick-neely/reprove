// The 2x2 a review asked for: static vs dynamic import, under each builder.
//
// The earlier conclusion ("module identity is builder-dependent") was
// confounded: the vitest measurement used a static import and the Turbopack one
// used a dynamic import, so the two axes were never separated.
import { read } from './instance.ts';

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
  const m = await import('./instance.ts');
  return m.read();
}
