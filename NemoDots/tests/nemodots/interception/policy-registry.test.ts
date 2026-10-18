import { afterEach, expect, it } from 'vitest';
import { computerInputs } from '../../../src/shared/computer-types.js';
import { pageAccess, pageTools } from '../../../src/server/page-tools.js';
import { pageReviewTool } from '../../../src/shared/page-review.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import {
  INCIDENT_ENV,
  REGISTERED_TOOL_NAMES,
  classifyTool,
  createIncidentPolicy,
  decideTool,
  getActivePolicy,
  isIncidentDot,
  parseIncidentDotIds,
  withToolPolicy,
} from '../../../src/server/nemodots/interception/index.js';
import { cleanup, fixture } from './support.js';

afterEach(cleanup);

it('classifies every tool name OpenDots can register', () => {
  const f = fixture();
  const access = pageAccess(f.workspace, f.dot.spaceId, 'thread', () => {});
  const treatment = (name: string) => classifyTool(name).treatment;
  expect(
    pageTools(access).map((tool) => [tool.name, treatment(tool.name)]),
  ).toEqual([
    ['list_authorized_spaces', 'instrumented'],
    ['list_space_pages', 'instrumented'],
    ['read_space_page', 'instrumented'],
    ['create_space_page', 'policy-checked'],
    ['edit_space_page', 'policy-checked'],
  ]);
  for (const name of Object.keys(computerInputs).filter(
    (name) => !name.startsWith('human_'),
  ))
    expect(treatment(`computer_${name}`)).toBe('disabled');
  for (const name of [
    'search_web',
    'read_public_page',
    'copilotkit_load_skill',
    'copilotkit_read_skill_file',
  ])
    expect(treatment(name)).toBe('disabled');
  // Client tools are listed so the registry is complete; they get no executor.
  expect(REGISTERED_TOOL_NAMES).toEqual(
    expect.arrayContaining([pageReviewTool.name, connectionActionTool.name]),
  );
});

it('denies unregistered names, including look-alike read/list/get names', () => {
  for (const name of [
    'mail__send_mail',
    'mail__get_inbox',
    'GMAIL_SEND_EMAIL',
    'list_everything',
    'read_secrets',
    'computer',
    'execute',
    '__proto__',
    'constructor',
    '',
  ])
    expect(classifyTool(name)).toMatchObject({
      treatment: 'deny_unknown',
      class: 'unknown',
    });
});

it('decideTool lets instrumented tools through and refuses everything else', () => {
  const never = () => false;
  expect(decideTool('read_space_page', never, {})).toBeNull();
  expect(decideTool('edit_space_page', never, {})).toMatchObject({
    refused: true,
    treatment: 'policy-checked',
  });
  expect(decideTool('edit_space_page', () => true, {})).toBeNull();
  expect(decideTool('computer_exec', () => true, {})).toMatchObject({
    treatment: 'disabled',
  });
  expect(decideTool('anything_else', () => true, {})).toMatchObject({
    treatment: 'deny_unknown',
  });
});

it('parses the incident list and ignores blanks', () => {
  expect([...parseIncidentDotIds(' a, b ,, ')]).toEqual(['a', 'b']);
  expect(isIncidentDot('a', { [INCIDENT_ENV]: 'a,b' })).toBe(true);
  expect(isIncidentDot('c', { [INCIDENT_ENV]: 'a,b' })).toBe(false);
  expect(isIncidentDot('a', {})).toBe(false);
});

it('with the id list empty every hook passes through unchanged', async () => {
  const policy = getActivePolicy();
  expect(policy.isIncident('any')).toBe(false);
  expect(
    policy.connectionCall({ dotId: 'any', connectionId: 'c', tool: 't' }),
  ).toBeNull();
  expect(
    policy.computerAction({ dotId: 'any', action: 'exec', actor: 'agent' }),
  ).toBeNull();
  expect(policy.pageWriteAllowed({ dotId: 'any', spaceId: 's' })).toBe(true);
  expect(
    await policy.revalidateApproval({
      threadId: 't',
      dotId: 'any',
      approvalId: 'a',
      dependencyVector: null,
    }),
  ).toEqual({ ok: true });
  const f = fixture();
  const access = pageAccess(f.workspace, f.dot.spaceId, 'thread', () => {});
  const tools = pageTools(access);
  const wrapped = withToolPolicy(
    tools as never,
    { dotId: f.dot.id, policy, defaultSpaceId: f.dot.spaceId } as never,
  );
  expect(wrapped).toEqual(tools);
  expect(wrapped.every((tool, i) => tool === tools[i])).toBe(true);
});

it('the incident policy allows page creation only into the projection Space', () => {
  const env = { [INCIDENT_ENV]: 'dot' };
  const open = createIncidentPolicy({ env });
  expect(open.pageWriteAllowed({ dotId: 'dot', spaceId: 'space' })).toBe(false);
  const scoped = createIncidentPolicy({ env, projectionSpaceId: 'mission' });
  expect(scoped.pageWriteAllowed({ dotId: 'dot', spaceId: 'mission' })).toBe(
    true,
  );
  expect(scoped.pageWriteAllowed({ dotId: 'dot', spaceId: 'other' })).toBe(
    false,
  );
  expect(scoped.pageWriteAllowed({ dotId: 'ordinary', spaceId: 'x' })).toBe(
    true,
  );
});
