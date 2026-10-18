import { afterEach, describe, expect, it } from 'vitest';
import { json, client, startStub, type Stub, MODEL } from './stub.js';

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('listModels / verifyModel (stub-verified)', () => {
  it('lists model ids with the bearer key', async () => {
    stub = await startStub((_req, res) =>
      json(res, 200, {
        object: 'list',
        data: [{ id: MODEL }, { id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B' }],
      }),
    );
    const { client: c } = client(stub);
    expect(await c.listModels()).toEqual([
      MODEL,
      'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    ]);
    expect(stub.seen[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(stub.seen[0].headers.authorization).toMatch(/^Bearer /);
  });

  it('verifyModel is true for a listed model without any billed probe', async () => {
    stub = await startStub((_req, res) =>
      json(res, 200, { data: [{ id: MODEL }] }),
    );
    const { client: c } = client(stub);
    expect(await c.verifyModel(MODEL)).toBe(true);
    expect(stub.seen).toHaveLength(1);
  });

  it('verifyModel is false for an unlisted model answered with the Crusoe 404 model_not_found envelope', async () => {
    stub = await startStub((req, res) =>
      req.method === 'GET'
        ? json(res, 200, { data: [{ id: MODEL }] })
        : json(res, 404, {
            code: 'model_not_found',
            message: 'Model not found: nvidia/does-not-exist',
            error_id: 'e',
          }),
    );
    const { client: c } = client(stub);
    expect(await c.verifyModel('nvidia/does-not-exist')).toBe(false);
    expect(stub.seen[1].body).toMatchObject({
      model: 'nvidia/does-not-exist',
      max_tokens: 1,
      reasoning_effort: 'none',
      stream: false,
    });
  });

  it('verifyModel is true for an unlisted but served model', async () => {
    stub = await startStub((req, res) =>
      req.method === 'GET'
        ? json(res, 200, { data: [] })
        : json(res, 200, {
            model: 'x',
            choices: [{ message: { content: 'p' }, finish_reason: 'length' }],
          }),
    );
    const { client: c } = client(stub);
    expect(await c.verifyModel('nvidia/unlisted')).toBe(true);
  });

  it('other failures throw instead of answering false', async () => {
    stub = await startStub((req, res) =>
      req.method === 'GET'
        ? json(res, 200, { data: [] })
        : json(res, 503, { code: 'unavailable' }),
    );
    const { client: c } = client(stub);
    await expect(c.verifyModel('nvidia/x')).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      httpStatus: 503,
    });
    const down = await startStub((_req, res) =>
      json(res, 401, { code: 'unauthorized' }),
    );
    const { client: d } = client(down);
    await expect(d.listModels()).rejects.toMatchObject({
      httpStatus: 401,
      code: 'unauthorized',
    });
    await down.close();
  });

  it('a malformed /models body throws invalid_response', async () => {
    stub = await startStub((_req, res) => json(res, 200, { nope: true }));
    const { client: c } = client(stub);
    await expect(c.listModels()).rejects.toMatchObject({
      errorClass: 'invalid_response',
    });
  });
});
