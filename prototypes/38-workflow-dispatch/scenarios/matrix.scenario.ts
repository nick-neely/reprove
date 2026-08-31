import { it, expect } from 'vitest';
import { start } from 'workflow/api';
import { read, inject } from '../probe/instance.ts';
import { matrixWorkflow } from '../probe/matrix.ts';

it('module identity: static vs dynamic, under @workflow/vitest', async () => {
  inject('set-by-caller');
  const caller = read();
  const run = await start(matrixWorkflow, []);
  const out = (await run.returnValue) as any;
  const line = (label: string, v: any) =>
    `  [DATA] ${label.padEnd(22)} instance=${v.instance} injected=${v.injected ?? 'null'}`;
  console.log('\n===== MODULE IDENTITY MATRIX: @workflow/vitest =====');
  console.log(line('caller', caller));
  console.log(line('step, static import', out.viaStatic));
  console.log(line('step, dynamic import', out.viaDynamic));
  console.log(
    `  [DATA] static === caller?  ${out.viaStatic.instance === caller.instance}\n` +
      `  [DATA] dynamic === caller? ${out.viaDynamic.instance === caller.instance}\n` +
      `  [DATA] static === dynamic? ${out.viaStatic.instance === out.viaDynamic.instance}`,
  );
  console.log('===================================================\n');
  expect(out.viaStatic.instance).toBeTruthy();
  expect(out.viaDynamic.instance).toBeTruthy();
});
