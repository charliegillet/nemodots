import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../../src/client/api', async () => {
  const { FakeApiError } = await import('./harness');
  return {
    api,
    ApiError: FakeApiError,
    setToken: () => {},
    authHeaders: () => ({}),
  };
});
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../../src/client/Chat', () => ({ Chat: () => null }));
vi.mock('../../../src/client/ThreadList', () => ({ ThreadList: () => null }));
vi.mock('../../../src/client/ResultPane', () => ({ ResultPane: () => null }));
vi.mock('../../../src/client/SpaceNav', () => ({ SpaceNav: () => null }));
vi.mock('../../../src/client/SpaceWorkspace', () => ({
  SpaceWorkspace: ({
    space,
    onDirty,
  }: {
    space: { name: string };
    onDirty: (dirty: boolean) => void;
  }) =>
    createElement(
      'section',
      { 'aria-label': 'Space workspace stub' },
      createElement('span', null, 'Space workspace stub'),
      createElement(
        'button',
        { 'aria-label': 'Mark draft dirty', onClick: () => onDirty(true) },
        space.name,
      ),
    ),
}));
vi.mock('../../../src/client/setup-telemetry', () => ({
  trackSetupStep: () => () => {},
}));

import { App } from '../../../src/client/App';
import { ids } from '../contracts/fixtures.js';
import { snapshot } from '../ui/helpers';
import {
  FakeApiError,
  byLabel,
  calls,
  fakeStream,
  healthDto,
  routedApi,
  textOf,
} from './harness';

const NOW = 1_760_000_000_000;
const state = {
  settings: {
    name: 'Dot',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
    appsAllowed: false,
  },
  tasks: [],
  memories: [{ id: 'm1', text: 'Remember the milk', createdAt: NOW }],
  mode: 'sample',
  configured: false,
};
const workspace = {
  spaces: [{ id: 's1', name: 'Home', description: '', createdAt: NOW }],
  dots: [
    {
      id: 'd1',
      spaceId: 's1',
      spaceIds: ['s1'],
      name: 'Helper',
      instructions: 'Help out.',
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: false,
      composioToolkits: [],
      createdAt: NOW,
    },
  ],
  conversations: [],
  setup: {
    intelligence: false,
    model: false,
    browser: false,
    voice: false,
    composio: false,
    slack: 'off',
    missing: ['model'],
  },
  calls: [],
};

// A small window/location/history so the hash route can be driven in Node.
function installBrowser(initialHash = '') {
  const listeners = new Set<() => void>();
  const loc = {
    _hash: initialHash,
    pathname: '/',
    search: '',
    get hash() {
      return this._hash;
    },
    set hash(value: string) {
      this._hash = value.startsWith('#') ? value : `#${value}`;
      for (const listener of [...listeners]) listener();
    },
  };
  class FakeHashChangeEvent {
    readonly type = 'hashchange';
  }
  vi.stubGlobal('HashChangeEvent', FakeHashChangeEvent);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const index = url.indexOf('#');
      loc._hash = index === -1 ? '' : url.slice(index);
    },
  });
  vi.stubGlobal('window', {
    location: loc,
    confirm: () => true,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.delete(listener);
    },
    dispatchEvent: () => {
      for (const listener of [...listeners]) listener();
      return true;
    },
  });
  return loc;
}

let root: ReactTestRenderer;
const MISSION_PATH = `/nemodots/missions/${ids.mission}`;

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

async function renderApp() {
  await act(async () => {
    root = create(createElement(App));
  });
  await settle();
}

const breadcrumb = () =>
  textOf(root).match(/(?:Dots|NemoDots|Home) \/ (\w+)/)?.[0] ?? '';
const railButton = (label: string) => byLabel(root.root, label)[0];
const navItem = (text: string) =>
  root.root.find(
    (node) =>
      node.type === 'button' &&
      String(node.props.className ?? '').includes('nav-item') &&
      node.findAll((n) => n.children.includes(text)).length > 0,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mockReset();
  routedApi(api, {
    'GET /state': state,
    'GET /workspace': workspace,
    'GET /nemodots/health': healthDto(),
    'GET /nemodots/sandbox/checkout/health': new Error('unavailable'),
    'GET /nemodots/missions': [],
    [`GET ${MISSION_PATH}`]: snapshot(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => fakeStream().response),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('product name in the user-facing copy', () => {
  it('the unlock screen says NemoDots and does not call the product a template or OpenDots', async () => {
    installBrowser();
    routedApi(api, {
      'GET /state': new FakeApiError('Enter your owner access token.', 401),
      'GET /workspace': new FakeApiError('Enter your owner access token.', 401),
    });
    await renderApp();
    const text = textOf(root);
    expect(text).toContain('NemoDots is locked.');
    expect(text).toContain('configured on this NemoDots server');
    expect(text).toContain('Unlock NemoDots');
    expect(text).not.toContain('little corner');
    expect(text).not.toMatch(/OpenDots|this template/);
  });

  it('keeps the upstream attribution in the sidebar and links to the upstream repository', async () => {
    installBrowser();
    await renderApp();
    expect(textOf(root)).toContain('BUILT ON OPENDOTS');
    const links = root.root.findAll(
      (node) =>
        node.type === 'a' &&
        String(node.props.href ?? '').startsWith(
          'https://github.com/CopilotKit/OpenDots',
        ),
    );
    expect(links.length).toBeGreaterThan(0);
  });
});

describe('App with the mission view', () => {
  it('still renders chat, activity and memories', async () => {
    installBrowser();
    await renderApp();
    expect(textOf(root)).toContain('Helper');
    expect(breadcrumb()).toBe('Dots / Helper');
    await act(async () => railButton('Open activity').props.onClick());
    expect(textOf(root)).toContain('A little follow-through.');
    expect(breadcrumb()).toBe('Dots / Activity');
    await act(async () => navItem('Memories').props.onClick());
    expect(textOf(root)).toContain('Remember the milk');
    expect(breadcrumb()).toBe('Dots / Memories');
  });

  it('still renders the space view from #/spaces/:id', async () => {
    installBrowser('#/spaces/s1');
    await renderApp();
    expect(textOf(root)).toContain('Space workspace stub');
    expect(breadcrumb()).toBe('Home / Pages');
  });

  it('adds Missions to the rail, sidebar and breadcrumb', async () => {
    const loc = installBrowser();
    await renderApp();
    expect(navItem('Missions').props['aria-current']).toBeUndefined();
    await act(async () => navItem('Missions').props.onClick());
    await settle();
    expect(loc.hash).toBe('#/missions');
    expect(navItem('Missions').props['aria-current']).toBe('page');
    expect(railButton('Open missions').props['aria-current']).toBe('page');
    expect(breadcrumb()).toBe('NemoDots / Missions');
    expect(textOf(root)).toContain('New mission');
    // Leaving the mission view clears its hash like any other view.
    await act(async () => railButton('Open activity').props.onClick());
    expect(loc.hash).toBe('');
    expect(textOf(root)).toContain('A little follow-through.');
  });

  it('selects the mission named by #/missions/<id>', async () => {
    installBrowser(`#/missions/${ids.mission}`);
    await renderApp();
    expect(calls(api, `GET ${MISSION_PATH}`).length).toBeGreaterThan(0);
    expect(textOf(root)).toContain('Investigate checkout errors');
    expect(textOf(root)).toContain('Restore checkout');
  });

  it('follows a later hash change to a mission', async () => {
    const loc = installBrowser();
    await renderApp();
    await act(async () => {
      loc.hash = `#/missions/${ids.mission}`;
    });
    await settle();
    expect(breadcrumb()).toBe('NemoDots / Missions');
    expect(textOf(root)).toContain('Investigate checkout errors');
  });

  it('keeps the dirty-draft guard when a hash change leaves a space for a mission', async () => {
    const loc = installBrowser('#/spaces/s1');
    const confirm = vi.fn(() => false);
    (window as unknown as { confirm: typeof confirm }).confirm = confirm;
    await renderApp();
    await act(async () =>
      byLabel(root.root, 'Mark draft dirty')[0].props.onClick(),
    );
    await act(async () => {
      loc.hash = '#/missions';
    });
    await settle();
    expect(confirm).toHaveBeenCalledWith('Leave your unsaved page draft?');
    expect(textOf(root)).toContain('Space workspace stub');
    expect(loc.hash).toBe('#/spaces/s1');
    confirm.mockReturnValue(true);
    await act(async () => {
      loc.hash = '#/missions';
    });
    await settle();
    expect(breadcrumb()).toBe('NemoDots / Missions');
  });
});
