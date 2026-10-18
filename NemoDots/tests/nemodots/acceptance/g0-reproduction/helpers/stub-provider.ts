// A stand-in provider endpoint for LABELLING checks only (live vs fixture vs
// blocked, reachable, modelListed). It proves nothing about inference quality.
import { createServer, type Server } from 'node:http';

export interface StubProvider {
  port: number;
  /** "METHOD path" of every request received. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * models: ids returned by GET /v1/models; 'down' answers every request 503.
 */
export async function startStubProvider(
  models: string[] | 'down',
): Promise<StubProvider> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (models === 'down') {
      res.statusCode = 503;
      res.end('{"error":"stub down"}');
      return;
    }
    if (
      req.method === 'GET' &&
      /^\/v1\/models\/?(\?.*)?$/.test(req.url ?? '')
    ) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: models.map((id) => ({ id, object: 'model' })),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"stub: not found"}');
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
