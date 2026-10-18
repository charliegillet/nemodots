import { describe, expect, it, vi } from 'vitest';
import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { ComputerService } from '../../../src/server/computer-service.js';
import { ConnectionService } from '../../../src/server/connections.js';
import { tanstackTools } from '../../../src/server/tanstack-tools.js';
import { defineTool } from '@copilotkit/runtime/v2';
import {
  ALLOW_ALL_POLICY,
  ToolPolicyError,
  createToolPolicy,
  setActivePolicy,
  withToolPolicy,
} from '../../../src/server/nemodots/interception/index.js';
import { dotFixture } from './helpers.js';

describe('ComputerService.audited (M6, M7)', () => {
  const service = (f: ReturnType<typeof dotFixture>) =>
    new ComputerService(
      f.workspace,
      {
        computerSupervisorUrl: 'https://supervisor.invalid',
        computerSupervisorToken: 'fixture',
        computerToken: 'fixture',
      } as never,
      () => false,
      (async () => {
        throw new Error('network must not be reached');
      }) as unknown as typeof fetch,
    );

  it('refuses agent actions on an incident Dot before opening an audit receipt', async () => {
    const f = dotFixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    await expect(
      service(f).action(f.dot.id, 'snapshot', {}, 'agent'),
    ).rejects.toThrow('Refused by NemoDots policy');
    await expect(
      service(f).action(f.dot.id, 'exec', { command: 'ls' }, 'agent'),
    ).rejects.toThrow('Refused by NemoDots policy');
    expect(f.workspace.computers.audit(f.dot.id)).toEqual([]);
  });

  it('allows the owner on an incident Dot (recorded, not blocked)', async () => {
    const f = dotFixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    const computer = service(f);
    await computer.permissions(f.dot.id, { enabled: true, browser: true });
    expect(f.workspace.computers.permissions(f.dot.id)).toMatchObject({
      enabled: true,
      browser: true,
    });
    // Past the policy the owner's action reaches the (failing) transport,
    // which is the sign it was not refused.
    await expect(
      computer.action(f.dot.id, 'snapshot', {}, 'owner'),
    ).rejects.not.toThrow('Refused by NemoDots policy');
    expect(f.workspace.computers.audit(f.dot.id).length).toBeGreaterThan(0);
  });

  it('does not touch other Dots or the default policy', async () => {
    const f = dotFixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: ['other'] }));
    await expect(
      service(f).action(f.dot.id, 'snapshot', {}, 'agent'),
    ).rejects.not.toThrow('Refused by NemoDots policy');
    setActivePolicy(null);
    await expect(
      service(f).action(f.dot.id, 'snapshot', {}, 'agent'),
    ).rejects.not.toThrow('Refused by NemoDots policy');
  });
});

describe('ConnectionService.call (R10, M8)', () => {
  const exposedFor = (f: ReturnType<typeof dotFixture>) => {
    f.workspace.connections.create(
      f.dot.id,
      { name: 'Mail', url: 'https://mail.example.invalid/mcp' },
      [
        {
          name: 'search_mail',
          title: 'Search',
          description: 'Search.',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
          enabled: true,
          requiresApproval: false,
        },
      ],
    );
    return new ConnectionService(f.workspace.connections, () => {
      throw new Error('transport must not be reached');
    });
  };

  it('refuses an incident Dot on any instance and returns the upstream error shape', async () => {
    const f = dotFixture();
    const service = exposedFor(f);
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    // A brand-new instance, like the per-turn one in dot-agent.ts.
    const perTurn = new ConnectionService(f.workspace.connections, () => {
      throw new Error('transport must not be reached');
    });
    for (const instance of [service, perTurn]) {
      const result = await instance.call(
        instance.resolve(f.dot.id, 'mail__search_mail'),
        {},
      );
      expect(result).toEqual({
        isError: true,
        text: expect.stringContaining('Refused by NemoDots policy'),
      });
    }
  });

  it('reaches the transport (and reports its failure the upstream way) when allowed', async () => {
    const f = dotFixture();
    const service = exposedFor(f);
    for (const policy of [null, createToolPolicy({ incidentDotIds: [] })]) {
      setActivePolicy(policy);
      const result = await service.call(
        service.resolve(f.dot.id, 'mail__search_mail'),
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('transport must not be reached');
    }
  });
});

describe('withToolPolicy (I7)', () => {
  const server = (name: string, execute = vi.fn(async () => 'ok')) =>
    toolDefinition({
      name,
      description: name,
      inputSchema: z.object({}),
    }).server(execute);

  it('wraps only tools that carry an executor and returns client tools untouched', async () => {
    const client = toolDefinition({
      name: 'review_space_page',
      description: 'client',
      inputSchema: z.object({}),
    }).client();
    expect((client as { execute?: unknown }).execute).toBeUndefined();
    const read = server('read_space_page');
    const edit = server('edit_space_page');
    const wrapped = withToolPolicy([read, client, edit], {
      dotId: 'inc',
      policy: () => createToolPolicy({ incidentDotIds: ['inc'] }),
    });
    expect(wrapped).toHaveLength(3);
    // The client tool is the very same object: still no executor.
    expect(wrapped[1]).toBe(client);
    expect((wrapped[1] as { execute?: unknown }).execute).toBeUndefined();
    expect(wrapped[0].execute).toBeTypeOf('function');
    expect(wrapped[0]).not.toBe(read);
    // Metadata survives the wrap.
    expect(wrapped[0].name).toBe('read_space_page');
    expect((wrapped[0] as { __toolSide?: string }).__toolSide).toBe(
      (read as { __toolSide?: string }).__toolSide,
    );
  });

  it('runs allowed tools, refuses disallowed ones with a ToolPolicyError and reports it', async () => {
    const readExec = vi.fn(async () => 'page');
    const editExec = vi.fn(async () => 'edited');
    const refusals: string[] = [];
    const [read, edit] = withToolPolicy(
      [
        server('read_space_page', readExec),
        server('edit_space_page', editExec),
      ],
      {
        dotId: 'inc',
        policy: () => createToolPolicy({ incidentDotIds: ['inc'] }),
        onRefusal: ({ toolName }) => refusals.push(toolName),
      },
    );
    await expect(read.execute!({}, undefined)).resolves.toBe('page');
    await expect(
      edit.execute!({ id: 'p' } as never, undefined),
    ).rejects.toBeInstanceOf(ToolPolicyError);
    expect(editExec).not.toHaveBeenCalled();
    expect(readExec).toHaveBeenCalledTimes(1);
    expect(refusals).toEqual(['edit_space_page']);
  });

  it('resolves the policy at call time and passes the origin and arguments to it', async () => {
    let active = ALLOW_ALL_POLICY;
    const seen: unknown[] = [];
    const [mail] = withToolPolicy([server('mail__send')], {
      dotId: 'inc',
      policy: () => active,
      origin: () => 'mcp',
    });
    await expect(mail.execute!({}, undefined)).resolves.toBe('ok');
    active = {
      ...createToolPolicy({ incidentDotIds: ['inc'] }),
      decideTool: (request) => {
        seen.push(request);
        return { allow: false, code: 'disabled_for_incident', reason: 'no' };
      },
    };
    await expect(
      mail.execute!({ to: 'x' } as never, undefined),
    ).rejects.toThrow('Refused by NemoDots policy: no');
    expect(seen).toEqual([
      {
        dotId: 'inc',
        toolName: 'mail__send',
        origin: 'mcp',
        args: { to: 'x' },
      },
    ]);
  });

  it('is compatible with the tools tanstackTools builds from CopilotKit definitions', async () => {
    const definition = defineTool({
      name: 'edit_space_page',
      description: 'd',
      parameters: z.object({}),
      execute: async () => 'edited',
    });
    const [edit] = withToolPolicy(tanstackTools([definition]), {
      dotId: 'inc',
      policy: () => createToolPolicy({ incidentDotIds: ['inc'] }),
    });
    await expect(edit.execute!({}, undefined)).rejects.toBeInstanceOf(
      ToolPolicyError,
    );
    const [allowed] = withToolPolicy(tanstackTools([definition]), {
      dotId: 'someone-else',
      policy: () => createToolPolicy({ incidentDotIds: ['inc'] }),
    });
    await expect(allowed.execute!({}, undefined)).resolves.toBe('edited');
  });
});
