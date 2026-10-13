/** Minimal JSON-RPC over fetch, for calls viem has no helper for (traces, anvil methods). */
export class RpcError extends Error {
	constructor(message: string, readonly code?: number, readonly data?: unknown) {
		super(message);
	}
}

export async function rpc<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 20_000): Promise<T> {
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
	const body = await res.json() as { result?: T; error?: { message: string; code?: number; data?: unknown } };
	if (body.error) {
		throw new RpcError(body.error.message, body.error.code, body.error.data);
	}
	return body.result as T;
}

/** Revert data carried by a failed eth_call / eth_estimateGas error, whatever the node's shape. */
export function revertData(err: unknown): `0x${string}` | undefined {
	const seen = new Set<unknown>();
	const walk = (v: unknown): string | undefined => {
		if (typeof v === 'string') {
			return /^0x[0-9a-fA-F]*$/.test(v) && (v.length - 2) % 2 === 0 ? v : undefined;
		}
		if (!v || typeof v !== 'object' || seen.has(v)) {
			return undefined;
		}
		seen.add(v);
		const o = v as Record<string, unknown>;
		return walk(o.data) ?? walk(o.cause) ?? walk(o.error) ?? walk(o.originalError);
	};
	return walk(err instanceof RpcError ? { data: err.data } : err) as `0x${string}` | undefined;
}

export const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
