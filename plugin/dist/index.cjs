"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src-js/index.ts
var src_js_exports = {};
__export(src_js_exports, {
  decode: () => decode,
  encode: () => encode,
  installShim: () => installShim
});
module.exports = __toCommonJS(src_js_exports);

// src-js/binary.ts
var BINARY_TAG = "__browser_proxy_binary__";
var DATE_TAG = "__browser_proxy_date__";
var MAP_TAG = "__browser_proxy_map__";
var SET_TAG = "__browser_proxy_set__";
function toBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(binary);
}
function fromBase64(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function encode(value) {
  if (value === null || value === void 0) return value;
  if (typeof value !== "object") return value;
  const maybeSerialize = value.__TAURI_TO_IPC_KEY__;
  if (typeof maybeSerialize === "function") {
    let key;
    try {
      key = maybeSerialize.call(value);
    } catch {
      key = null;
    }
    if (typeof key === "string" && key.startsWith("__CHANNEL__:")) {
      const id = Number(key.slice("__CHANNEL__:".length));
      if (Number.isFinite(id)) {
        return { __browser_proxy_channel__: true, shim_id: id };
      }
    }
  }
  if (value instanceof ArrayBuffer) {
    return makeBinary(new Uint8Array(value), "ArrayBuffer");
  }
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor?.name ?? "Uint8Array";
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return makeBinary(bytes, name);
  }
  if (value instanceof Date) {
    return { [DATE_TAG]: true, iso: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries = [];
    value.forEach((v, k) => entries.push([encode(k), encode(v)]));
    return { [MAP_TAG]: true, entries };
  }
  if (value instanceof Set) {
    const items = [];
    value.forEach((v) => items.push(encode(v)));
    return { [SET_TAG]: true, items };
  }
  if (Array.isArray(value)) return value.map(encode);
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = encode(value[k]);
  }
  return out;
}
function makeBinary(u8, kind) {
  return { [BINARY_TAG]: true, kind, data: toBase64(u8) };
}
function decode(value) {
  if (value === null || value === void 0) return value;
  if (typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof Date) return value;
  if (value instanceof Map) return value;
  if (value instanceof Set) return value;
  const rec = value;
  if (rec[BINARY_TAG]) {
    const bytes = fromBase64(rec.data);
    switch (rec.kind) {
      case "ArrayBuffer":
        return bytes.buffer;
      case "Uint8Array":
        return bytes;
      case "Int8Array":
        return new Int8Array(bytes.buffer);
      case "Uint8ClampedArray":
        return new Uint8ClampedArray(bytes.buffer);
      case "Uint16Array":
        return new Uint16Array(bytes.buffer);
      case "Int16Array":
        return new Int16Array(bytes.buffer);
      case "Uint32Array":
        return new Uint32Array(bytes.buffer);
      case "Int32Array":
        return new Int32Array(bytes.buffer);
      case "Float32Array":
        return new Float32Array(bytes.buffer);
      case "Float64Array":
        return new Float64Array(bytes.buffer);
      case "BigInt64Array":
        return new BigInt64Array(bytes.buffer);
      case "BigUint64Array":
        return new BigUint64Array(bytes.buffer);
      default:
        return bytes;
    }
  }
  if (rec[DATE_TAG]) return new Date(rec.iso);
  if (rec[MAP_TAG]) {
    const m = /* @__PURE__ */ new Map();
    rec.entries.forEach(([k, v]) => m.set(decode(k), decode(v)));
    return m;
  }
  if (rec[SET_TAG]) {
    const s = /* @__PURE__ */ new Set();
    rec.items.forEach((i) => s.add(decode(i)));
    return s;
  }
  if (Array.isArray(value)) return value.map(decode);
  const out = {};
  for (const k of Object.keys(rec)) {
    out[k] = decode(rec[k]);
  }
  return out;
}

// src-js/shim.ts
var installed = false;
function installShim(options = {}) {
  if (installed && !options.force) return;
  const hasRealTauri = typeof globalThis.__TAURI_INTERNALS__?.invoke === "function" && !options.force;
  if (hasRealTauri) {
    console.info("[browser-proxy] real __TAURI_INTERNALS__ present, shim skipped");
    installed = true;
    return;
  }
  installed = true;
  const base = options.url ?? (typeof globalThis.__BROWSER_PROXY_URL__ === "string" ? globalThis.__BROWSER_PROXY_URL__ : "http://127.0.0.1:1421");
  const listeners = /* @__PURE__ */ new Map();
  const serverSubscribed = /* @__PURE__ */ new Set();
  let nextListenerId = 1;
  let lastSeq = 0;
  const channelsSeenInArgs = /* @__PURE__ */ new Set();
  async function httpInvoke(body) {
    const channelIds = [];
    collectChannelIds(body.args, channelIds);
    await Promise.all(channelIds.map(subscribeChannel));
    const resp = await fetch(`${base}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, args: encode(body.args) })
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    return await resp.json();
  }
  async function subscribe(event) {
    if (serverSubscribed.has(event)) return;
    serverSubscribed.add(event);
    const resp = await fetch(`${base}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event })
    });
    if (!resp.ok) {
      serverSubscribed.delete(event);
      throw new Error(`subscribe(${event}) failed: HTTP ${resp.status}`);
    }
  }
  async function unsubscribe(event) {
    if (!serverSubscribed.has(event)) return;
    serverSubscribed.delete(event);
    await fetch(`${base}/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event })
    }).catch(() => {
    });
  }
  function dispatch(event, payload) {
    if (event.startsWith("__browser_proxy_channel__:")) {
      const shimId = Number(event.slice("__browser_proxy_channel__:".length));
      const slot = window[`_${shimId}`];
      if (typeof slot === "function") {
        try {
          slot(payload);
        } catch (e) {
          console.error("[browser-proxy] channel handler threw", e);
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
  async function subscribeChannel(shimId) {
    if (channelsSeenInArgs.has(shimId)) return;
    channelsSeenInArgs.add(shimId);
    await subscribe(`__browser_proxy_channel__:${shimId}`);
  }
  function collectChannelIds(value, out) {
    if (value === null || value === void 0) return;
    if (typeof value !== "object") return;
    const fn = value.__TAURI_TO_IPC_KEY__;
    if (typeof fn === "function") {
      try {
        const key = fn.call(value);
        if (typeof key === "string" && key.startsWith("__CHANNEL__:")) {
          const id = Number(key.slice("__CHANNEL__:".length));
          if (Number.isFinite(id)) out.push(id);
          return;
        }
      } catch {
      }
    }
    if (Array.isArray(value)) {
      value.forEach((v) => collectChannelIds(v, out));
      return;
    }
    for (const k of Object.keys(value)) {
      collectChannelIds(value[k], out);
    }
  }
  let es = null;
  let reconnectTimer = null;
  function openStream() {
    if (es) return;
    const url = `${base}/events?since=${lastSeq}`;
    es = new EventSource(url);
    es.addEventListener("open", () => options.onOpen?.());
    es.addEventListener("tauri", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        lastSeq = Math.max(lastSeq, data.seq);
        dispatch(data.event, decode(data.payload));
      } catch (e) {
        console.error("[browser-proxy] malformed event", e);
      }
    });
    es.addEventListener("error", (e) => {
      options.onError?.(e);
      es?.close();
      es = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          openStream();
        }, 1e3);
      }
    });
  }
  openStream();
  window.addEventListener("online", () => {
    serverSubscribed.clear();
    for (const name of listeners.keys()) {
      subscribe(name).catch(() => {
      });
    }
  });
  const internals = {
    async invoke(cmd, args, opts) {
      const reply = await httpInvoke({ cmd, args: args ?? {}, options: opts });
      if (reply.ok) return decode(reply.data);
      throw new Error(reply.error);
    },
    transformCallback(cb, _once) {
      const id = Math.floor(Math.random() * 2 ** 32);
      window[`_${id}`] = (payload) => {
        if (_once) delete window[`_${id}`];
        cb(decode(payload));
      };
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    convertFileSrc(path, protocol = "asset") {
      const encoded = encodeURIComponent(path);
      return `${protocol}://localhost/${encoded}`;
    }
    // ----- Intercept the event plugin's listen/unlisten -----
    // Most apps use `@tauri-apps/api/event` which calls
    // invoke('plugin:event|listen', ...) directly. We intercept those in
    // httpInvoke via the plugin:event namespace below.
  };
  const baseInvoke = internals.invoke.bind(internals);
  internals.invoke = async function(cmd, args, opts) {
    if (cmd === "plugin:event|listen") {
      const event = args?.event;
      const handlerId = args?.handler;
      if (typeof event !== "string" || typeof handlerId !== "number") {
        throw new Error("plugin:event|listen: event name and handler id required");
      }
      const map = listeners.get(event) ?? /* @__PURE__ */ new Map();
      listeners.set(event, map);
      const localId = nextListenerId++;
      map.set(localId, (evt) => {
        const cb = window[`_${handlerId}`];
        if (typeof cb === "function") cb({ event: evt.event, id: localId, payload: evt.payload });
      });
      await subscribe(event);
      return localId;
    }
    if (cmd === "plugin:event|unlisten") {
      const event = args?.event;
      const eventId = args?.eventId;
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
    if (cmd === "plugin:event|emit") {
      return baseInvoke(cmd, args, opts);
    }
    return baseInvoke(cmd, args, opts);
  };
  const target = window;
  target.__TAURI_INTERNALS__ = internals;
  target.__TAURI_INTERNALS__.__TAURI_PATTERN__ = { pattern: "brownfield" };
  if (!target.__TAURI_METADATA__) {
    target.__TAURI_METADATA__ = { __currentWindow: { label: "browser" }, __windows: [] };
  }
  if (!target.__TAURI_EVENT_PLUGIN_INTERNALS__) {
    target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {
      }
    };
  }
}
//# sourceMappingURL=index.cjs.map