import { createServer, type Server } from 'node:http';

/** Tiny health endpoint for container orchestrators (docs/archive/specs/13 §6). */
export function startHealthServer(port: number, readiness: () => Promise<boolean>): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/health/ready') {
      readiness()
        .then((ok) => res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ready' : 'not_ready' })))
        .catch(() => res.writeHead(503).end());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  return server;
}
