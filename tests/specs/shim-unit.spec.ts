// Shim unit test — exercises the browser-side shim against a hand-rolled
// mock of the Tauri-side server. Runs in Playwright's headless Chromium
// without needing a real Tauri app (which is flaky in headless due to
// webkit EGL requirements).
//
// This test proves:
//   1. The shim POSTs invokes in the correct wire format, with binary args
//      base64-wrapped.
//   2. It decodes binary results into live typed arrays.
//   3. It subscribes through /subscribe and dispatches SSE events to the
//      right listeners.
//   4. `emit` is forwarded as plugin:event|emit.

import { test, expect } from '@playwright/test';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

test.describe('shim wire protocol', () => {
  let server: http.Server;
  let port: number;
  const invokeCalls: Array<{ cmd: string; args: any }> = [];
  const subscribed = new Set<string>();
  let sseWrite: ((event: string, data: any) => void) | null = null;

  test.beforeAll(async () => {
    // Stand up a tiny mock of the Tauri-side server.
    server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

      if (req.url === '/health') { res.end('ok'); return; }

      if (req.url === '/invoke' && req.method === 'POST') {
        collectJson(req).then((body: any) => {
          invokeCalls.push(body);
          res.setHeader('content-type', 'application/json');

          // Simulate a few commands.
          if (body.cmd === 'echo_bytes') {
            // Return the decoded input bytes reversed — lets us prove the
            // binary round-trip survives intact.
            const incoming = body.args?.buf; // encoded
            const bin = incoming?.__browser_proxy_binary__
              ? Buffer.from(incoming.data, 'base64')
              : Buffer.alloc(0);
            const reversed = Buffer.from(bin).reverse();
            res.end(JSON.stringify({
              ok: true,
              data: {
                __browser_proxy_binary__: true,
                kind: 'Uint8Array',
                data: reversed.toString('base64'),
              },
            }));
            return;
          }
          if (body.cmd === 'greet') {
            res.end(JSON.stringify({ ok: true, data: `hi ${body.args?.name ?? 'x'}` }));
            return;
          }
          if (body.cmd === 'plugin:event|emit') {
            // Fire the event back via SSE so the browser-side listener sees it.
            setTimeout(() => {
              if (sseWrite) sseWrite('tauri', {
                event: body.args.event,
                payload: body.args.payload,
                seq: 1,
              });
            }, 10);
            res.end(JSON.stringify({ ok: true, data: null }));
            return;
          }
          res.end(JSON.stringify({ ok: false, error: `unknown cmd ${body.cmd}` }));
        });
        return;
      }

      if (req.url === '/subscribe' && req.method === 'POST') {
        collectJson(req).then((body: any) => {
          subscribed.add(body.event);
          res.statusCode = 204; res.end();
        });
        return;
      }
      if (req.url === '/unsubscribe' && req.method === 'POST') {
        collectJson(req).then((body: any) => {
          subscribed.delete(body.event);
          res.statusCode = 204; res.end();
        });
        return;
      }
      if (req.url?.startsWith('/events') && req.method === 'GET') {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.write(`event: hello\ndata: {"since":0}\n\n`);
        sseWrite = (event, data) => {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {}
        };
        req.on('close', () => { sseWrite = null; });
        return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as any).port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.beforeEach(() => {
    invokeCalls.length = 0;
    subscribed.clear();
  });

  test('invoke + binary round-trip + emit/listen', async ({ page }) => {
    // Surface console noise so test failures are diagnosable.
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('[page error]', e.message));
    // Read the built shim.js off disk and inline it — sidesteps the module
    // resolver, which can't find the file via a relative import on a
    // setContent'd page (there is no baseURL).
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const shimPath = fileURLToPath(new URL('../../plugin/dist/shim.js', import.meta.url));
    const shimSource = readFileSync(shimPath, 'utf8');
    await page.setContent(`<!doctype html>
<html><head><script type="module">
  ${shimSource}
  window.__shim_ready__ = false;
  // The built ESM module runs installShim via its exports — but inlining it
  // loses the export binding. Assign the function manually before use:
  //   our tsup build exports installShim as a top-level const, which the
  //   inlined code leaves in scope.
  installShim({ url: 'http://127.0.0.1:${port}', onOpen: () => { window.__shim_ready__ = true; } });
  window.doInvoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  window.doListen = (name, cb) => {
    const id = window.__TAURI_INTERNALS__.transformCallback(cb);
    return window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: name, target: { kind: 'Any' }, handler: id,
    });
  };
  window.doEmit = (name, payload) =>
    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: name, payload });
</script></head><body><h1>shim harness</h1></body></html>`);

    await page.waitForFunction(() => (window as any).__shim_ready__ === true, { timeout: 10_000 });

    // 1. plain invoke
    const greeting = await page.evaluate(() =>
      (window as any).doInvoke('greet', { name: 'protocol' })
    );
    expect(greeting).toBe('hi protocol');

    // 2. binary round-trip
    const reversed = await page.evaluate(async () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0x00, 0x80]);
      const out = await (window as any).doInvoke('echo_bytes', { buf: input });
      return {
        type: out.constructor.name,
        arr: Array.from(out as Uint8Array),
      };
    });
    expect(reversed.type).toBe('Uint8Array');
    expect(reversed.arr).toEqual([0x80, 0x00, 0xff, 8, 7, 6, 5, 4, 3, 2, 1]);

    // Verify the wire format of the outbound echo_bytes request:
    const echoCall = invokeCalls.find((c) => c.cmd === 'echo_bytes');
    expect(echoCall).toBeTruthy();
    expect(echoCall!.args.buf.__browser_proxy_binary__).toBe(true);
    expect(echoCall!.args.buf.kind).toBe('Uint8Array');
    // base64 of [1,2,3,4,5,6,7,8,255,0,128] = AQIDBAUGBwj/AIA=
    expect(echoCall!.args.buf.data).toBe('AQIDBAUGBwj/AIA=');

    // 3. emit → SSE → listen
    const gotPayload = page.evaluate(async () => {
      return new Promise((resolve) => {
        (window as any).doListen('xyz', (evt: any) => resolve(evt.payload));
        setTimeout(() => (window as any).doEmit('xyz', { hi: 'there' }), 50);
      });
    });
    await expect.poll(() => subscribed.has('xyz')).toBe(true);
    expect(await gotPayload).toEqual({ hi: 'there' });
  });
});

async function collectJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
