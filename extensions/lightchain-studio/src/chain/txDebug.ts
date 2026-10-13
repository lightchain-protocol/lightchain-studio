import { Hex, formatEther } from 'viem';
import { AbiIndex, DecodedCall, DecodedEvent, DecodedRevert } from './abiIndex';
import { hex, revertData, rpc } from './rpc';

/**
 * Transaction debugger: what a transaction did, and when it failed, why — in
 * the contract's own words and in plain ones. Works from the public RPC: the
 * transaction, its receipt, a replay of the call for the revert reason, and the
 * node's call trace when it offers one.
 */
export interface TraceCall { depth: number; type: string; to: string; toName?: string; text: string; value?: string; failed?: string }

export interface TxReport {
	hash: string;
	status: 'success' | 'failed' | 'pending' | 'missing';
	from?: string;
	to?: string;
	toName?: string;
	created?: string;
	value?: string;
	call?: DecodedCall;
	selector?: string;
	gasUsed?: number;
	gasLimit?: number;
	fee?: string;
	block?: number;
	revert?: DecodedRevert;
	outOfGas?: boolean;
	events: { address: string; contract?: string; text: string }[];
	trace: TraceCall[];
	/** What happened, in two or three sentences. */
	summary: string;
}

interface RawTx { from: string; to: string | null; input: string; value: string; gas: string; blockNumber: string | null }
interface RawReceipt { status: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: { address: string; topics: Hex[]; data: Hex }[] }
interface RawTrace { type?: string; from?: string; to?: string; input?: string; value?: string; error?: string; revertReason?: string; output?: string; calls?: RawTrace[] }

const lcai = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 6 })} LCAI`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function summarize(r: Omit<TxReport, 'summary'>): string {
	if (r.status === 'missing') {
		return 'This transaction was not found on this network. Check the hash, and that you are on the right network (testnet or mainnet).';
	}
	const who = r.from ? short(r.from) : 'Someone';
	const target = r.toName ?? (r.to ? short(r.to) : undefined);
	const did = r.created || !r.to ? 'deployed a contract' : r.call ? `called ${r.call.text} on ${target}` : r.selector ? `called a function this project does not know (${r.selector}) on ${target}` : `sent ${r.value ?? '0 LCAI'} to ${target}`;
	const withValue = r.value && r.value !== '0 LCAI' && (r.call || r.created) ? `, sending ${r.value} along` : '';
	if (r.status === 'pending') {
		return `${who} ${did}${withValue}. It has not been included in a block yet.`;
	}
	if (r.status === 'success') {
		const made = r.created ? ` The new contract is at ${r.created}.` : '';
		const events = r.events.length ? ` It emitted ${r.events.length} event${r.events.length === 1 ? '' : 's'}${r.events[0] ? `, starting with ${r.events[0].text}` : ''}.` : '';
		return `${who} ${did}${withValue}, and it worked.${made}${events}${r.fee ? ` It cost ${r.fee} in fees.` : ''}`;
	}
	const why = r.outOfGas && (!r.revert || r.revert.kind === 'empty')
		? 'It ran out of gas: the limit set for the transaction was used up before it finished. Send it again with a higher gas limit, or make the function do less.'
		: r.revert?.plain ?? 'The reason could not be read from the network.';
	return `${who} ${did}${withValue}, and it failed. ${why} Nothing was changed${r.fee ? `, but ${r.fee} was paid in fees` : ''}.`;
}

function flatten(t: RawTrace, abis: AbiIndex, names: Map<string, string>, depth: number, out: TraceCall[]): void {
	const to = t.to ?? '';
	const toName = names.get(to.toLowerCase());
	const call = abis.decodeCall(t.input as Hex | undefined, toName);
	const failed = t.error ? (t.revertReason ?? (t.output && t.output !== '0x' ? abis.decodeRevert(t.output as Hex).text : t.error)) : undefined;
	out.push({
		depth, type: (t.type ?? 'CALL').toLowerCase(), to, toName: toName ?? call?.contract,
		text: call?.text ?? (t.input && t.input.length >= 10 ? `function ${t.input.slice(0, 10)}` : 'plain transfer'),
		value: t.value && BigInt(t.value) > 0n ? lcai(BigInt(t.value)) : undefined, failed,
	});
	(t.calls ?? []).forEach(c => flatten(c, abis, names, depth + 1, out));
}

/** `names`: lower-case address → contract name, for the project's deployed contracts. */
export async function inspectTx(rpcUrl: string, hash: string, abis: AbiIndex, names = new Map<string, string>()): Promise<TxReport> {
	const [tx, receipt] = await Promise.all([
		rpc<RawTx | null>(rpcUrl, 'eth_getTransactionByHash', [hash]),
		rpc<RawReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [hash]),
	]);
	if (!tx) {
		const missing = { hash, status: 'missing' as const, events: [], trace: [] };
		return { ...missing, summary: summarize(missing) };
	}
	const toName = tx.to ? names.get(tx.to.toLowerCase()) : undefined;
	const call = tx.to ? abis.decodeCall(tx.input as Hex, toName) : undefined;
	const base: Omit<TxReport, 'summary'> = {
		hash, status: !receipt ? 'pending' : receipt.status === '0x1' ? 'success' : 'failed',
		from: tx.from, to: tx.to ?? undefined, toName: toName ?? call?.contract, created: receipt?.contractAddress ?? undefined,
		value: lcai(BigInt(tx.value)), call, selector: tx.to && tx.input.length >= 10 && !call ? tx.input.slice(0, 10) : undefined,
		gasLimit: Number(BigInt(tx.gas)), block: tx.blockNumber ? Number(BigInt(tx.blockNumber)) : undefined,
		events: [], trace: [],
	};
	if (receipt) {
		base.gasUsed = Number(BigInt(receipt.gasUsed));
		base.fee = receipt.effectiveGasPrice ? lcai(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) : undefined;
		base.events = receipt.logs.map(l => {
			const e: DecodedEvent | undefined = abis.decodeEvent(l);
			return { address: l.address, contract: names.get(l.address.toLowerCase()) ?? e?.contract, text: e?.text ?? `event ${l.topics[0]?.slice(0, 10) ?? '(anonymous)'}` };
		});
	}
	if (base.status === 'failed' && tx.blockNumber) {
		base.outOfGas = base.gasUsed !== undefined && base.gasLimit !== undefined && base.gasUsed >= base.gasLimit * 0.99;
		// replay the call on the state just before its block to read why it reverted
		try {
			await rpc(rpcUrl, 'eth_call', [{ from: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas }, hex(BigInt(tx.blockNumber) - 1n)]);
		} catch (err) {
			const data = revertData(err);
			base.revert = data !== undefined ? abis.decodeRevert(data) : /revert/i.test((err as Error).message) ? { kind: 'unknown', text: (err as Error).message, plain: `The network says: ${(err as Error).message}.` } : undefined;
		}
	}
	// the node's own call trace, when it has the debug API
	try {
		const trace = await rpc<RawTrace>(rpcUrl, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }], 8_000);
		if (trace && (trace.calls?.length || trace.error)) {
			flatten(trace, abis, names, 0, base.trace);
			const deepest = [...base.trace].reverse().find(t => t.failed);
			if (base.status === 'failed' && !base.revert && deepest?.failed) {
				base.revert = { kind: 'unknown', text: deepest.failed, plain: `The call to ${deepest.toName ?? deepest.to} failed: ${deepest.failed}.` };
			}
		}
	} catch { /* no debug API on this node */ }
	return { ...base, summary: summarize(base) };
}
