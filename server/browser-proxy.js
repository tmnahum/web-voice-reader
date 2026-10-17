import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { normalizeUrl, publicIP } from './fetch.js';

// DNS validation happens at the actual connection boundary, not just on navigation.
export async function publicAddress(host, resolveHost = lookup) {
  let timer;
  try {
    const addresses = await Promise.race([
      resolveHost(host.replace(/^\[|\]$/g, ''), {all:true}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), 8000); }),
    ]);
    if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new Error('Local and private network addresses cannot be archived.');
    return addresses[0];
  } finally { clearTimeout(timer); }
}

export async function createBrowserProxy({resolveHost = lookup, connect = net.connect, maxBytes = 40_000_000} = {}) {
  const sockets = new Set();
  let bytes = 0, closed = false, connections = 0;
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    return socket;
  };
  const dial = async (host, port) => {
    if (++connections > 240 || closed) throw new Error('Browser connection limit exceeded.');
    const address = await publicAddress(host, resolveHost);
    if (closed) throw new Error('Proxy closed.');
    const socket = track(connect({host: address.address, family: address.family, port}));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { closed = true; for (const s of sockets) s.destroy(); }
    });
    return socket;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(normalizeUrl(req.url));
      if (url.protocol !== 'http:') throw new Error('Use CONNECT for HTTPS.');
      const socket = await dial(url.hostname, 80);
      if (req.destroyed) { socket.destroy(); return; }
      const headers = {...req.headers, host: url.host};
      // Never relay proxy credentials or hop-by-hop headers to the destination.
      for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) delete headers[key];
      const upstream = http.request({hostname:url.hostname, port:80, path:url.pathname + url.search, method:req.method, headers, agent:undefined, createConnection:() => socket}, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end(); }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    try {
      // CONNECT accepts an authority only, and HTTPS only on its standard port.
      if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(req.url)) throw new Error('Invalid tunnel authority.');
      const url = new URL(`https://${req.url}`);
      const upstream = await dial(url.hostname, 443);
      if (client.destroyed) { upstream.destroy(); return; }
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get bytes() { return bytes; },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
