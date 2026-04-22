// Binary codec used by both the browser shim and the Tauri interceptor.
// Keep this dependency-free so it runs in every environment.

const BINARY_TAG = '__browser_proxy_binary__';
const DATE_TAG = '__browser_proxy_date__';
const MAP_TAG = '__browser_proxy_map__';
const SET_TAG = '__browser_proxy_set__';

type BinaryKind =
  | 'ArrayBuffer'
  | 'Uint8Array'
  | 'Int8Array'
  | 'Uint8ClampedArray'
  | 'Uint16Array'
  | 'Int16Array'
  | 'Uint32Array'
  | 'Int32Array'
  | 'Float32Array'
  | 'Float64Array'
  | 'BigInt64Array'
  | 'BigUint64Array';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]
    );
  }
  return btoa(binary);
}
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encode(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Tauri Channel objects — recognized by the `__TAURI_TO_IPC_KEY__`
  // method Tauri's IPC serializer calls. If its return string starts with
  // `__CHANNEL__:`, we preserve the id so the Tauri-side interceptor can
  // build a matching real Channel that forwards messages back via SSE.
  const maybeSerialize = (value as { __TAURI_TO_IPC_KEY__?: () => unknown })
    .__TAURI_TO_IPC_KEY__;
  if (typeof maybeSerialize === 'function') {
    let key: unknown;
    try { key = maybeSerialize.call(value); } catch { key = null; }
    if (typeof key === 'string' && key.startsWith('__CHANNEL__:')) {
      const id = Number(key.slice('__CHANNEL__:'.length));
      if (Number.isFinite(id)) {
        return { __browser_proxy_channel__: true, shim_id: id };
      }
    }
  }

  if (value instanceof ArrayBuffer) {
    return makeBinary(new Uint8Array(value), 'ArrayBuffer');
  }
  if (ArrayBuffer.isView(value)) {
    const name = (value.constructor?.name ?? 'Uint8Array') as BinaryKind;
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return makeBinary(bytes, name);
  }
  if (value instanceof Date) {
    return { [DATE_TAG]: true, iso: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [];
    value.forEach((v, k) => entries.push([encode(k), encode(v)]));
    return { [MAP_TAG]: true, entries };
  }
  if (value instanceof Set) {
    const items: unknown[] = [];
    value.forEach((v) => items.push(encode(v)));
    return { [SET_TAG]: true, items };
  }
  if (Array.isArray(value)) return value.map(encode);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    out[k] = encode((value as Record<string, unknown>)[k]);
  }
  return out;
}

function makeBinary(u8: Uint8Array, kind: BinaryKind) {
  return { [BINARY_TAG]: true, kind, data: toBase64(u8) };
}

export function decode(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // Idempotence: if the value is already a live typed array / binary, a
  // second decode() must leave it alone. Without this, a Uint8Array gets
  // walked as an indexed object and turned into a plain `{0:…, 1:…}` map.
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof Date) return value;
  if (value instanceof Map) return value;
  if (value instanceof Set) return value;
  const rec = value as Record<string, unknown>;
  if (rec[BINARY_TAG]) {
    const bytes = fromBase64(rec.data as string);
    switch (rec.kind as BinaryKind) {
      case 'ArrayBuffer':
        return bytes.buffer;
      case 'Uint8Array':
        return bytes;
      case 'Int8Array':
        return new Int8Array(bytes.buffer);
      case 'Uint8ClampedArray':
        return new Uint8ClampedArray(bytes.buffer);
      case 'Uint16Array':
        return new Uint16Array(bytes.buffer);
      case 'Int16Array':
        return new Int16Array(bytes.buffer);
      case 'Uint32Array':
        return new Uint32Array(bytes.buffer);
      case 'Int32Array':
        return new Int32Array(bytes.buffer);
      case 'Float32Array':
        return new Float32Array(bytes.buffer);
      case 'Float64Array':
        return new Float64Array(bytes.buffer);
      case 'BigInt64Array':
        return new BigInt64Array(bytes.buffer);
      case 'BigUint64Array':
        return new BigUint64Array(bytes.buffer);
      default:
        return bytes;
    }
  }
  if (rec[DATE_TAG]) return new Date(rec.iso as string);
  if (rec[MAP_TAG]) {
    const m = new Map();
    (rec.entries as [unknown, unknown][]).forEach(([k, v]) => m.set(decode(k), decode(v)));
    return m;
  }
  if (rec[SET_TAG]) {
    const s = new Set();
    (rec.items as unknown[]).forEach((i) => s.add(decode(i)));
    return s;
  }
  if (Array.isArray(value)) return value.map(decode);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    out[k] = decode(rec[k]);
  }
  return out;
}
