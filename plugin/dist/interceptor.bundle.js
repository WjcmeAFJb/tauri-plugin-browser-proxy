// tauri-plugin-browser-proxy — interceptor
// Injected via Builder::js_init_script into every Tauri webview. Runs before
// the user's page JS loads. We:
//   1. Stamp a marker so the shim can detect "I'm in the real webview".
//   2. Expose encode/decode helpers the server's `/invoke` eval uses to move
//      binary data (ArrayBuffer, Uint8Array, other TypedArrays) through JSON.
//   3. Expose subscribe/unsubscribe helpers the server calls when a browser
//      tab wants to listen to a given event — we attach a *real* Tauri
//      listener and forward every firing back via `relay_event`.
//   4. Register the webview as the proxy "bridge" so the plugin knows where
//      to dispatch invokes. First webview wins unless `pinned_webview` is set.
//
// Everything is wrapped in a check: only run if __TAURI_INTERNALS__ is
// present. That avoids breaking non-Tauri contexts where the script might
// accidentally be loaded (e.g. Vite's SSR pipeline).

(function () {
  if (typeof window === 'undefined') return;
  if (!window.__TAURI_INTERNALS__) {
    // Tauri hasn't finished booting yet; try again on next microtask.
    queueMicrotask(function () {
      if (window.__TAURI_INTERNALS__) install();
    });
    return;
  }
  install();

  function install() {
    if (window.__BROWSER_PROXY_INSTALLED__) return;
    window.__BROWSER_PROXY_INSTALLED__ = true;

    var BINARY_TAG = '__browser_proxy_binary__';
    var invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);

    // ----- base64 helpers (work on binary without corrupting UTF-16) -----
    function toBase64(bytes) {
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }
    function fromBase64(b64) {
      var binary = atob(b64);
      var len = binary.length;
      var out = new Uint8Array(len);
      for (var i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
      return out;
    }

    // ----- Recursively encode values for JSON transport -----
    // Supported: ArrayBuffer, typed arrays, Map, Set, Date, plain objects/arrays.
    function encode(value) {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'object') return value;

      if (value instanceof ArrayBuffer) {
        return makeBinary(new Uint8Array(value), 'ArrayBuffer');
      }
      if (ArrayBuffer.isView(value)) {
        var ctor = value.constructor && value.constructor.name;
        var bytes;
        if (value instanceof Uint8Array) {
          bytes = value;
        } else {
          bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        return makeBinary(bytes, ctor || 'Uint8Array');
      }
      if (value instanceof Date) {
        return { __browser_proxy_date__: true, iso: value.toISOString() };
      }
      if (value instanceof Map) {
        var entries = [];
        value.forEach(function (v, k) { entries.push([encode(k), encode(v)]); });
        return { __browser_proxy_map__: true, entries: entries };
      }
      if (value instanceof Set) {
        var items = [];
        value.forEach(function (v) { items.push(encode(v)); });
        return { __browser_proxy_set__: true, items: items };
      }
      if (Array.isArray(value)) {
        return value.map(encode);
      }
      // Plain object (or class). We only walk own enumerable props.
      var out = {};
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          out[k] = encode(value[k]);
        }
      }
      return out;
    }

    function makeBinary(u8, kind) {
      var obj = {};
      obj[BINARY_TAG] = true;
      obj.kind = kind;
      obj.data = toBase64(u8);
      return obj;
    }

    function makeBridgeChannel(shimId) {
      // Build a Channel-compatible object the real Tauri deserializer will
      // accept. Tauri's IPC serializer looks for __TAURI_TO_IPC_KEY__ (not
      // toJSON) to reduce a Channel to its wire form "__CHANNEL__:<id>".
      var realId = window.__TAURI_INTERNALS__.transformCallback(function (msg) {
        invoke('plugin:browser-proxy|relay_event', {
          event: '__browser_proxy_channel__:' + shimId,
          payload: encode(msg),
        });
      });
      var ch = {
        id: realId,
        __TAURI_CHANNEL_MARKER__: true,
      };
      ch.__TAURI_TO_IPC_KEY__ = function () { return '__CHANNEL__:' + ch.id; };
      ch.toJSON = ch.__TAURI_TO_IPC_KEY__;
      return ch;
    }

    function decode(value) {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'object') return value;
      // Idempotence — see src-js/binary.ts.
      if (value instanceof ArrayBuffer) return value;
      if (ArrayBuffer.isView(value)) return value;
      if (value instanceof Date) return value;
      if (value instanceof Map) return value;
      if (value instanceof Set) return value;
      if (value.__browser_proxy_channel__) {
        var ch = makeBridgeChannel(value.shim_id);
        console.log('[browser-proxy] decoded channel', value.shim_id, '->', ch.id, 'ipc=', ch.__TAURI_TO_IPC_KEY__());
        return ch;
      }
      if (value[BINARY_TAG]) {
        var bytes = fromBase64(value.data);
        switch (value.kind) {
          case 'ArrayBuffer': return bytes.buffer;
          case 'Uint8Array': return bytes;
          case 'Int8Array': return new Int8Array(bytes.buffer);
          case 'Uint8ClampedArray': return new Uint8ClampedArray(bytes.buffer);
          case 'Uint16Array': return new Uint16Array(bytes.buffer);
          case 'Int16Array': return new Int16Array(bytes.buffer);
          case 'Uint32Array': return new Uint32Array(bytes.buffer);
          case 'Int32Array': return new Int32Array(bytes.buffer);
          case 'Float32Array': return new Float32Array(bytes.buffer);
          case 'Float64Array': return new Float64Array(bytes.buffer);
          case 'BigInt64Array': return new BigInt64Array(bytes.buffer);
          case 'BigUint64Array': return new BigUint64Array(bytes.buffer);
          default: return bytes;
        }
      }
      if (value.__browser_proxy_date__) return new Date(value.iso);
      if (value.__browser_proxy_map__) {
        var m = new Map();
        value.entries.forEach(function (e) { m.set(decode(e[0]), decode(e[1])); });
        return m;
      }
      if (value.__browser_proxy_set__) {
        var s = new Set();
        value.items.forEach(function (i) { s.add(decode(i)); });
        return s;
      }
      if (Array.isArray(value)) return value.map(decode);
      var out = {};
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          out[k] = decode(value[k]);
        }
      }
      return out;
    }

    // Expose to the eval'd snippet the Rust server injects.
    window.__browser_proxy_encode__ = encode;
    window.__browser_proxy_decode__ = decode;

    // ----- Event subscriptions -----
    // Per-event: remember the unlisten handle so the server can unsubscribe.
    var subscribers = Object.create(null);

    function ensureEventModule() {
      // The event plugin lives at 'plugin:event|listen' etc. We call it
      // directly via invoke to avoid importing @tauri-apps/api (which might
      // not be bundled in the Tauri page).
      return {
        listen: function (name, handler) {
          // We must transform the handler via transformCallback so Tauri's
          // Rust side knows where to dispatch.
          var cb = window.__TAURI_INTERNALS__.transformCallback(function (evt) {
            try {
              handler(evt);
            } catch (e) {
              console.error('[browser-proxy] listener threw', e);
            }
          });
          return invoke('plugin:event|listen', {
            event: name,
            target: { kind: 'Any' },
            handler: cb,
          }).then(function (id) {
            return { id: id, cb: cb, event: name };
          });
        },
        unlisten: function (h) {
          return invoke('plugin:event|unlisten', { event: h.event, eventId: h.id });
        },
      };
    }

    var eventMod = ensureEventModule();

    // `id` is optional — if given, we confirm the subscription via relay_result
    // so the HTTP /subscribe handler can block until the real Tauri listener
    // is live. That keeps `listen(...)` + immediate `emit(...)` race-free.
    window.__browser_proxy_subscribe__ = function (name, id) {
      function confirm(ok, error) {
        if (!id) return;
        invoke('plugin:browser-proxy|relay_result', {
          id: id,
          ok: ok,
          data: null,
          error: error || null,
        });
      }
      if (subscribers[name]) { confirm(true, null); return; }
      var pending = { pending: true };
      subscribers[name] = pending;
      eventMod
        .listen(name, function (evt) {
          invoke('plugin:browser-proxy|relay_event', {
            event: name,
            payload: encode(evt && evt.payload !== undefined ? evt.payload : evt),
          });
        })
        .then(function (handle) {
          if (subscribers[name] !== pending) {
            eventMod.unlisten(handle);
            confirm(true, null);
            return;
          }
          subscribers[name] = handle;
          confirm(true, null);
        })
        .catch(function (err) {
          delete subscribers[name];
          console.error('[browser-proxy] listen(' + name + ') failed', err);
          confirm(false, (err && err.message) || String(err));
        });
    };

    window.__browser_proxy_unsubscribe__ = function (name) {
      var h = subscribers[name];
      if (!h) return;
      delete subscribers[name];
      if (h.pending) return; // subscribe() in-flight will notice it's gone.
      eventMod.unlisten(h).catch(function () { /* ignore */ });
    };

    // ----- Register this webview as the bridge -----
    // First webview wins, unless the plugin has a pinned label.
    invoke('plugin:browser-proxy|register_bridge').catch(function (e) {
      console.warn('[browser-proxy] register_bridge failed (will retry)', e);
      // Retry once after a tick, in case the plugin hadn't finished setup.
      setTimeout(function () {
        invoke('plugin:browser-proxy|register_bridge').catch(function () {});
      }, 100);
    });
  }
})();
