export { ShimOptions, installShim } from './shim.js';

declare function encode(value: unknown): unknown;
declare function decode(value: unknown): unknown;

export { decode, encode };
