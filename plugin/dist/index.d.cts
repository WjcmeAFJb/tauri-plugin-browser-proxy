export { ShimOptions, installShim } from './shim.cjs';

declare function encode(value: unknown): unknown;
declare function decode(value: unknown): unknown;

export { decode, encode };
