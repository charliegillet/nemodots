import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { vi } from 'vitest';
import {
  health as healthFixture,
  mission as missionFixture,
} from '../contracts/fixtures.js';
import type { ev } from '../ui/helpers';

// Shared helpers for the mission-page tests: a routed fake for the OpenDots
// api() wrapper, a controllable SSE endpoint behind a fake fetch, and tree
// queries for react-test-renderer.

export class FakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type Handler = unknown | ((body: unknown, path: string) => unknown);

/** Routes api(path, method, body) by "METHOD path"; unknown routes answer 404. */
export function routedApi(
  api: ReturnType<typeof vi.fn>,
  routes: Record<string, Handler>,
) {
  api.mockImplementation(
    async (path: string, method = 'GET', body?: unknown) => {
      const handler = routes[`${method} ${path}`];
      if (handler === undefined)
        throw new FakeApiError(`No route for ${method} ${path}`, 404);
      if (handler instanceof Error) throw handler;
      return typeof handler === 'function' ? handler(body, path) : handler;
    },
  );
}

export const calls = (api: ReturnType<typeof vi.fn>, key: string) =>
  api.mock.calls.filter(
    (call) => `${(call[1] as string | undefined) ?? 'GET'} ${call[0]}` === key,
  );

export const healthDto = (patch: Record<string, unknown> = {}) => ({
  ...healthFixture(),
  ...patch,
});

export const missionDto = (patch: Record<string, unknown> = {}) => ({
  ...missionFixture(),
  ...patch,
});

const encoder = new TextEncoder();
export const sseFrame = (event: ReturnType<typeof ev> | object) =>
  `id: ${(event as { id: number }).id}\ndata: ${JSON.stringify(event)}\n\n`;

export interface FakeStream {
  response: Response;
  push: (...frames: string[]) => void;
  close: () => void;
}

export function fakeStream(): FakeStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (...frames) => {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
    close: () => controller.close(),
  };
}

// ---------------------------------------------------------------------------
// react-test-renderer queries

type Json = ReturnType<ReactTestRenderer['toJSON']>;

export function textOf(renderer: ReactTestRenderer): string {
  const walk = (node: NonNullable<Json> | string): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join(' ');
    return (node.children ?? []).map((child) => walk(child as never)).join(' ');
  };
  const json = renderer.toJSON();
  if (!json) return '';
  return (Array.isArray(json) ? json : [json])
    .map((node) => walk(node as never))
    .join(' ')
    .replace(/\s+/g, ' ');
}

export const hostNodes = (root: ReactTestInstance) =>
  root.findAll((node) => typeof node.type === 'string');

export const byLabel = (root: ReactTestInstance, label: string) =>
  root.findAll(
    (node) =>
      typeof node.type === 'string' && node.props['aria-label'] === label,
  );

const flat = (node: ReactTestInstance | string): string =>
  typeof node === 'string'
    ? node
    : node.children.map((child) => flat(child)).join('');

export function buttonByText(root: ReactTestInstance, text: string) {
  const found = root.findAll(
    (node) => node.type === 'button' && flat(node).trim() === text,
  );
  if (found.length === 0) throw new Error(`No button "${text}"`);
  return found[0];
}

export function changeValue(node: ReactTestInstance, value: string) {
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
}
