// Browser-side shim. Install via `import '@tauri-plugin/browser-proxy/shim'`
// or via the Vite plugin's auto-injection. The shim wires a fake
// `window.__TAURI_INTERNALS__` into the browser tab so code that uses
// `@tauri-apps/api` *Just Works* — every invoke is POSTed to the running
// Tauri app, every event comes back over SSE.

import { encode, decode } from './binary';

export interface ShimOptions {
  /** Base URL of the Tauri proxy server. Defaults to reading
   *  `window.__BROWSER_PROXY_URL__` then `http://127.0.0.1:1421`. */
  url?: string;
  /** Called when the SSE connection opens. */
  onOpen?: () => void;
  /** Called when the SSE connection errors out — you may want to show
   *  a "Tauri app not running" banner. */
  onError?: (err: unknown) => void;
  /** If `true`, overwrite any pre-existing `__TAURI_INTERNALS__`. Default
   *  `false` — the shim detects the real Tauri webview and becomes a no-op
   *  there, so you usually want the default. */
  force?: boolean;
}

type InvokeBody = { cmd: string; args: unknown; options?: unknown };
type InvokeReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

type Listener = (event: { event: string; id: number; payload: unknown }) => void;

let installed = false;

export function installShim(options: ShimOptions = {}): void {
  if (installed && !options.force) return;

  // Detect real Tauri webview first — avoid opening a needless SSE stream
  // and then tripping over ourselves. The interceptor script stamps
  // __BROWSER_PROXY_INSTALLED__ on the real webview.
  const hasRealTauri =
    typeof (globalThis as any).__TAURI_INTERNALS__?.invoke === 'function' &&
    !options.force;
  if (hasRealTauri) {
    console.info('[browser-proxy] real __TAURI_INTERNALS__ present, shim skipped');
    installed = true;
    return;
  }

  installed = true;

  const base =
    options.url ??
    (typeof (globalThis as any).__BROWSER_PROXY_URL__ === 'string'
      ? (globalThis as any).__BROWSER_PROXY_URL__
      : 'http://127.0.0.1:1421');

  // Listener bookkeeping.
  const listeners = new Map<string, Map<number, Listener>>();
  const serverSubscribed = new Set<string>();
  let nextListenerId = 1;
  let lastSeq = 0;

  // Channels walked out of invoke args. We subscribe to a synthetic event
  // per channel so Tauri-emitted messages route back to the user's
  // `channel.onmessage`.
  const channelsSeenInArgs = new Set<number>();

  async function httpInvoke(body: InvokeBody): Promise<InvokeReply> {
    // Walk args for Tauri Channels and subscribe to their synthetic events
    // before firing the invoke — if we didn't, the first message from
    // Rust could arrive before the SSE subscription is live.
    const channelIds: number[] = [];
    collectChannelIds(body.args, channelIds);
    await Promise.all(channelIds.map(subscribeChannel));
    const resp = await fetch(`${base}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, args: encode(body.args) }),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    return (await resp.json()) as InvokeReply;
  }

  async function subscribe(event: string): Promise<void> {
    if (serverSubscribed.has(event)) return;
    serverSubscribed.add(event);
    const resp = await fetch(`${base}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    if (!resp.ok) {
      serverSubscribed.delete(event);
      throw new Error(`subscribe(${event}) failed: HTTP ${resp.status}`);
    }
  }

  async function unsubscribe(event: string): Promise<void> {
    if (!serverSubscribed.has(event)) return;
    serverSubscribed.delete(event);
    await fetch(`${base}/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  }

  function dispatch(event: string, payload: unknown): void {
    // Channel messages are delivered through synthetic events named
    // `__browser_proxy_channel__:<shim_id>`. Route them to the user's
    // Channel instance by invoking its stored callback slot.
    if (event.startsWith('__browser_proxy_channel__:')) {
      const shimId = Number(event.slice('__browser_proxy_channel__:'.length));
      const slot = (window as any)[`_${shimId}`];
      if (typeof slot === 'function') {
        try { slot(payload); } catch (e) {
          console.error('[browser-proxy] channel handler threw', e);
        }
      }
      return;
    }
    const map = listeners.get(event);
    if (!map || map.size === 0) return;
    for (const [id, fn] of map) {
      try {
        fn({ event, id, payload });
      } catch (e) {
        console.error(`[browser-proxy] listener for ${event} threw`, e);
      }
    }
  }

  async function subscribeChannel(shimId: number): Promise<void> {
    if (channelsSeenInArgs.has(shimId)) return;
    channelsSeenInArgs.add(shimId);
    await subscribe(`__browser_proxy_channel__:${shimId}`);
  }

  function collectChannelIds(value: unknown, out: number[]): void {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') return;
    const fn = (value as { __TAURI_TO_IPC_KEY__?: () => unknown }).__TAURI_TO_IPC_KEY__;
    if (typeof fn === 'function') {
      try {
        const key = fn.call(value);
        if (typeof key === 'string' && key.startsWith('__CHANNEL__:')) {
          const id = Number(key.slice('__CHANNEL__:'.length));
          if (Number.isFinite(id)) out.push(id);
          return; // do not recurse into Channel internals
        }
      } catch { /* ignore */ }
    }
    if (Array.isArray(value)) { value.forEach((v) => collectChannelIds(v, out)); return; }
    for (const k of Object.keys(value as Record<string, unknown>)) {
      collectChannelIds((value as Record<string, unknown>)[k], out);
    }
  }

  // ----- SSE connection (auto-reconnect) -----
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  function openStream() {
    if (es) return;
    const url = `${base}/events?since=${lastSeq}`;
    es = new EventSource(url);
    es.addEventListener('open', () => options.onOpen?.());
    es.addEventListener('tauri', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          event: string;
          payload: unknown;
          seq: number;
        };
        lastSeq = Math.max(lastSeq, data.seq);
        dispatch(data.event, decode(data.payload));
      } catch (e) {
        console.error('[browser-proxy] malformed event', e);
      }
    });
    es.addEventListener('error', (e) => {
      options.onError?.(e);
      es?.close();
      es = null;
      // Exponential-ish backoff, but capped.
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          openStream();
        }, 1000);
      }
    });
  }
  openStream();

  // Re-subscribe all known events when we reconnect.
  // (Each reopen triggers a fresh hello; the server's state is per-connection.)
  // We approximate by re-POSTing /subscribe for everything we track.
  window.addEventListener('online', () => {
    serverSubscribed.clear();
    for (const name of listeners.keys()) {
      subscribe(name).catch(() => {});
    }
  });

  // ----- The fake __TAURI_INTERNALS__ object -----
  const internals: any = {
    async invoke(cmd: string, args?: unknown, opts?: unknown) {
      const reply = await httpInvoke({ cmd, args: args ?? {}, options: opts });
      if (reply.ok) return decode(reply.data);
      throw new Error(reply.error);
    },

    transformCallback(cb: (payload: unknown) => void, _once?: boolean) {
      // Plugins occasionally call transformCallback directly. We emulate by
      // storing the cb in a global slot and returning a numeric id.
      const id = Math.floor(Math.random() * 2 ** 32);
      (window as any)[`_${id}`] = (payload: unknown) => {
        if (_once) delete (window as any)[`_${id}`];
        cb(decode(payload));
      };
      return id;
    },

    unregisterCallback(id: number) {
      delete (window as any)[`_${id}`];
    },

    convertFileSrc(path: string, protocol = 'asset') {
      const encoded = encodeURIComponent(path);
      // Match Tauri's convention. The server's /asset endpoint would be
      // needed for full parity with the asset:// scheme — we return the
      // literal asset URL which *most* apps use only for `<img src>` and
      // similar. For the fs plugin, readFile returns bytes directly so
      // this is rarely exercised in practice.
      return `${protocol}://localhost/${encoded}`;
    },

    // ----- Intercept the event plugin's listen/unlisten -----
    // Most apps use `@tauri-apps/api/event` which calls
    // invoke('plugin:event|listen', ...) directly. We intercept those in
    // httpInvoke via the plugin:event namespace below.
  };

  // Override invoke specifically for event plugin commands so subscriptions
  // are managed locally.
  const baseInvoke = internals.invoke.bind(internals);
  internals.invoke = async function (cmd: string, args?: any, opts?: unknown) {
    if (cmd === 'plugin:event|listen') {
      const event: string = args?.event;
      const handlerId: number = args?.handler;
      if (typeof event !== 'string' || typeof handlerId !== 'number') {
        throw new Error('plugin:event|listen: event name and handler id required');
      }
      const map = listeners.get(event) ?? new Map<number, Listener>();
      listeners.set(event, map);
      const localId = nextListenerId++;
      // The handler in our shim was stored via transformCallback above.
      // Look it up and register.
      map.set(localId, (evt) => {
        const cb = (window as any)[`_${handlerId}`];
        if (typeof cb === 'function') cb({ event: evt.event, id: localId, payload: evt.payload });
      });
      await subscribe(event);
      return localId;
    }
    if (cmd === 'plugin:event|unlisten') {
      const event: string = args?.event;
      const eventId: number = args?.eventId;
      const map = listeners.get(event);
      if (map) {
        map.delete(eventId);
        if (map.size === 0) {
          listeners.delete(event);
          await unsubscribe(event);
        }
      }
      return;
    }
    if (cmd === 'plugin:event|emit') {
      // Forward emit through to the Tauri side so native listeners receive it.
      return baseInvoke(cmd, args, opts);
    }
    return baseInvoke(cmd, args, opts);
  };

  // ----- Stamp the fake globals so @tauri-apps/api can see them -----
  const target = window as any;
  target.__TAURI_INTERNALS__ = internals;
  target.__TAURI_INTERNALS__.__TAURI_PATTERN__ = { pattern: 'brownfield' };
  if (!target.__TAURI_METADATA__) {
    target.__TAURI_METADATA__ = { __currentWindow: { label: 'browser' }, __windows: [] };
  }
  // The event plugin's JS helpers poke at this global during unlisten;
  // we don't need its machinery (we do our own tracking) but we must not
  // throw on property access. Provide a no-op stub.
  if (!target.__TAURI_EVENT_PLUGIN_INTERNALS__) {
    target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };
  }
}
