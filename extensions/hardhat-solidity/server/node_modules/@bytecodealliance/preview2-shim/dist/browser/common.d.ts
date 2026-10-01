export declare const MAX_U64: bigint;
/** Validate and return a WebAssembly u64 value. */
export declare function checkedU64(value: bigint, name: string): bigint;
/** Convert a WebAssembly u64 value to a lossless JavaScript number. */
export declare function checkedU64AsNumber(value: bigint, name: string): number;
