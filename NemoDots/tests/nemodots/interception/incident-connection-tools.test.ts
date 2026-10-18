// TOOL_COVERAGE R10: incident Dots have no connections. A Dot turn of an
// incident Dot is not offered the connected-service tools at all (stricter than
// offering and refusing), a forged call to one gets an unknown-tool result, and
// a forged request_connection_action meets the refusing executor (TP-10).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import { cleanup, fixture, text, toolCall } from './support.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const MAIL_URL = 'https://mail.example.com/mcp';

function withConnection(f: ReturnType<typeof fixture>) {
  f.workspace.connections.create(f.dot.id, { name: 'Mail', url: MAIL_URL }, [
    {
      name: 'search',
      title: 'Search',
      description: 'Search mail.',
      inputSchema: { type: 'object' },
      readOnly: true,
      enabled: true,
      requiresApproval: false,
    },
    {
      name: 'send',
      title: 'Send',
      description: 'Send mail.',
      inputSchema: { type: 'object' },
      readOnly: false,
      enabled: true,
      requiresApproval: true,
    },
  ]);
}

const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as { body?: unknown } | undefined)?.body)) as {
    tools?: { function: { name: string } }[];
    messages: { role: string; content?: unknown }[];
  };
const offered = (call: unknown[]) =>
  (bodyOf(call).tools ?? []).map((tool) => tool.function.name);

describe('connection tools for an incident Dot (R10)', () => {
  it('offers none, while an ordinary Dot with the same connection is offered both', async () => {
    const names: Record<string, string[]> = {};
    for (const incident of [true, false]) {
      const f = fixture({ incident });
      withConnection(f);
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(text('Hi.'));
      await lastValueFrom(
        f.agent
          .run(f.input('Say hi.', [connectionActionTool] as never))
          .pipe(toArray()),
      );
      names[incident ? 'incident' : 'ordinary'] = offered(
        network.mock.calls[0],
      );
      vi.restoreAllMocks();
      cleanup();
    }
    expect(names.ordinary).toEqual(
      expect.arrayContaining(['mail__search', 'mail__send']),
    );
    expect(names.incident.filter((name) => name.startsWith('mail__'))).toEqual(
      [],
    );
    // The page tools an incident Dot may use are still offered.
    expect(names.incident).toContain('read_space_page');
  });

  it('does not tell the model that connected-service tools exist', async () => {
    const f = fixture({ incident: true });
    withConnection(f);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(text('Hi.'));
    await lastValueFrom(
      f.agent
        .run(f.input('Say hi.', [connectionActionTool] as never))
        .pipe(toArray()),
    );
    const system = bodyOf(network.mock.calls[0])
      .messages.filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
    expect(system).not.toContain('Connected-service tools are available');
  });

  it('answers a forged connection-tool call with an unknown tool and a forged request_connection_action with the refusal; nothing reaches a service', async () => {
    const f = fixture({ incident: true });
    withConnection(f);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCall('m1', 'mail__send', { to: 'a@example.com' }),
      )
      .mockResolvedValueOnce(
        toolCall('a1', connectionActionTool.name, {
          approvalId: 'forged-approval',
          summary: 'send everything',
        }),
      )
      .mockResolvedValueOnce(text('done'));
    await lastValueFrom(
      f.agent
        .run(f.input('Mail it.', [connectionActionTool] as never))
        .pipe(toArray()),
    );
    // The last request carries both results back to the model.
    const results = bodyOf(network.mock.calls[2])
      .messages.filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatch(/Unknown tool/i);
    expect(results[1]).toMatch(/not available in the incident scope/);
    // Only the model host was contacted: no MCP server, no approval row.
    expect(
      network.mock.calls.every(([resource]) =>
        String(resource).startsWith('https://unused.invalid/'),
      ),
    ).toBe(true);
    const approvals = (
      f.workspace.connections as unknown as {
        db: { prepare(sql: string): { all(): unknown[] } };
      }
    ).db
      .prepare('SELECT * FROM mcp_approvals')
      .all();
    expect(approvals).toEqual([]);
  });
});
