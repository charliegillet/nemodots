// Context layouts for the 2x2 (strategy x layout). Both layouts come from the
// one compiler (context/compile.ts); they carry the same information and differ
// only in ordering: cache_aware puts the stable authorized prefix first and the
// volatile time last, ordinary puts the time first and interleaves runbooks
// with evidence. `assertSameInformation` is the parity check the runner and the
// tests use, so a layout can never win by carrying more or less.
import {
  compileContext,
  type CompileContextInput,
  type CompiledContext,
} from '../context/index.js';
import type { ContextLayout } from '../contracts/index.js';
import { LAYOUT_NAMES, type LayoutName } from './types.js';

export const LAYOUT_DESCRIPTIONS: Readonly<Record<LayoutName, string>> =
  Object.freeze({
    cache_aware:
      'common instructions + tools, runbooks, role, then evidence, task and the volatile time last',
    ordinary:
      'volatile time first, then instructions and role, with runbooks and evidence interleaved',
  });

export function isLayoutName(value: string): value is LayoutName {
  return (LAYOUT_NAMES as readonly string[]).includes(value);
}

/** The compiler layout for an arm. The names are identical by design. */
export function contextLayoutFor(name: LayoutName): ContextLayout {
  return name;
}

export function compileBothLayouts(
  input: Omit<CompileContextInput, 'layout'>,
): Record<LayoutName, CompiledContext> {
  return {
    cache_aware: compileContext({ ...input, layout: 'cache_aware' }),
    ordinary: compileContext({ ...input, layout: 'ordinary' }),
  };
}

/** Lines of a system string with the layout-dependent headings removed. */
function informationLines(system: string): string[] {
  return system
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('## '))
    .sort();
}

export class LayoutInformationMismatch extends Error {
  constructor(readonly detail: string) {
    super(`layouts differ in information content: ${detail}`);
    this.name = 'LayoutInformationMismatch';
  }
}

/**
 * Equal information: the same multiset of non-heading lines in the system
 * string, the same messages, the same tools and the same snapshot dependency
 * vector and injected items. Only ordering and headings may differ.
 */
export function assertSameInformation(
  a: CompiledContext,
  b: CompiledContext,
): void {
  const left = informationLines(a.system);
  const right = informationLines(b.system);
  if (left.length !== right.length || left.some((line, i) => line !== right[i]))
    throw new LayoutInformationMismatch('system lines');
  if (JSON.stringify(a.messages) !== JSON.stringify(b.messages))
    throw new LayoutInformationMismatch('messages');
  if (a.snapshot.toolSchemaHash !== b.snapshot.toolSchemaHash)
    throw new LayoutInformationMismatch('tool schema hash');
  if (
    JSON.stringify(a.snapshot.dependencyVector) !==
    JSON.stringify(b.snapshot.dependencyVector)
  )
    throw new LayoutInformationMismatch('dependency vector');
  if (
    JSON.stringify(a.snapshot.injected) !== JSON.stringify(b.snapshot.injected)
  )
    throw new LayoutInformationMismatch('injected items');
}
