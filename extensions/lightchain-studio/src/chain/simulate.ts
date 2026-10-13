import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { Abi, Hex, decodeFunctionResult, encodeFunctionData, formatEther } from 'viem';
import { AbiIndex, DecodedRevert, show, stateReaders } from './abiIndex';
import { hex, revertData, rpc } from './rpc';

/**
 * Simulate before signing: runs a transaction on a private copy of the chain
 * (an anvil fork that lives for a few seconds) and reports what it would do —
 * whether it works, what it costs, which balances and contract values change
 * and which events fire. Nothing is sent to the real network.
 *
 * Without anvil the transaction is only dry-run with eth_call: that still
 * tells whether it would fail and why, but not what it changes.
 */
export interface SimTx { from: string; to?: string; data?: Hex; value?: bigint }
export interface Simulation {
	ok: boolean;
	how: 'fork' | 'call';
	revert?: DecodedRevert;
	gasUsed?: bigint;
	fee?: bigint;
	created?: string;
	balances: { label: string; address: string; before: bigint; after: bigint }[];
	state: { name: string; before: string; after: string }[];
	events: string[];
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const port = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(port));
		});
	});
}

async function readState(url: string, to: string, abi: Abi): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	await Promise.all(stateReaders(abi).slice(0, 16).map(async fn => {
		try {
			const raw = await rpc<Hex>(url, 'eth_call', [{ to, data: encodeFunctionData({ abi: [fn], functionName: fn.name }) }, 'latest'], 8_000);
			out.set(fn.name, show(decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw })));
		} catch { /* a getter that reverts: leave it out */ }
	}));
	return out;
}

export interface SimOptions {
	rpcUrl: string;
	tx: SimTx;
	abis: AbiIndex;
	/** ABI of the contract being called (or deployed), to read its values before and after. */
	abi?: Abi;
	toLabel?: string;
	/** Path to anvil; without it only a dry run is possible. */
	anvil?: string;
	signal?: AbortSignal;
}

export async function simulate(o: SimOptions): Promise<Simulation> {
	const call = { from: o.tx.from, to: o.tx.to, data: o.tx.data, value: o.tx.value !== undefined ? hex(o.tx.value) : undefined };
	const dryRun = async (): Promise<Simulation> => {
		try {
			await rpc(o.rpcUrl, 'eth_call', [call, 'latest']);
			const gas = await rpc<string>(o.rpcUrl, 'eth_estimateGas', [call]).catch(() => undefined);
			const price = await rpc<string>(o.rpcUrl, 'eth_gasPrice').catch(() => undefined);
			return { ok: true, how: 'call', gasUsed: gas ? BigInt(gas) : undefined, fee: gas && price ? BigInt(gas) * BigInt(price) : undefined, balances: [], state: [], events: [] };
		} catch (err) {
			const data = revertData(err);
			return { ok: false, how: 'call', revert: data !== undefined ? o.abis.decodeRevert(data) : { kind: 'unknown', text: (err as Error).message, plain: `The network says: ${(err as Error).message.split('\n')[0]}.` }, balances: [], state: [], events: [] };
		}
	};
	if (!o.anvil) {
		return dryRun();
	}
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const child = spawn(o.anvil, ['--fork-url', o.rpcUrl, '--port', String(port), '--auto-impersonate', '--no-storage-caching', '--silent'], { stdio: 'ignore' });
	const stop = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
	o.signal?.addEventListener('abort', stop, { once: true });
	try {
		// wait for the fork to answer
		let up = false;
		for (let i = 0; i < 60 && !up && !o.signal?.aborted && child.exitCode === null; i++) {
			up = await rpc<string>(url, 'eth_chainId', [], 1_000).then(() => true, () => false);
			if (!up) {
				await new Promise(r => setTimeout(r, 250));
			}
		}
		if (!up) {
			return dryRun();
		}
		const watched = [{ label: 'Your wallet', address: o.tx.from }, ...(o.tx.to ? [{ label: o.toLabel ?? 'The contract', address: o.tx.to }] : [])];
		const balance = (a: string) => rpc<string>(url, 'eth_getBalance', [a, 'latest']).then(BigInt);
		const before = await Promise.all(watched.map(w => balance(w.address)));
		const stateBefore = o.tx.to && o.abi ? await readState(url, o.tx.to, o.abi) : new Map<string, string>();
		let hash: string;
		try {
			hash = await rpc<string>(url, 'eth_sendTransaction', [call], 30_000);
		} catch (err) {
			const data = revertData(err);
			if (data === undefined && !/revert/i.test((err as Error).message)) {
				return dryRun();
			}
			return { ok: false, how: 'fork', revert: data !== undefined ? o.abis.decodeRevert(data) : { kind: 'unknown', text: (err as Error).message, plain: `The network says: ${(err as Error).message.split('\n')[0]}.` }, balances: [], state: [], events: [] };
		}
		type Receipt = { status: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: { address: string; topics: Hex[]; data: Hex }[] };
		let receipt: Receipt | null = null;
		for (let i = 0; i < 50 && !receipt; i++) {
			receipt = await rpc<Receipt | null>(url, 'eth_getTransactionReceipt', [hash]);
			if (!receipt) {
				await new Promise(r => setTimeout(r, 200)); // mined a moment after it is accepted
			}
		}
		if (!receipt) {
			return dryRun();
		}
		if (receipt.status !== '0x1') {
			// mined but reverted: the dry run carries the reason
			const dry = await dryRun();
			return { ...dry, ok: false, how: 'fork', gasUsed: BigInt(receipt.gasUsed) };
		}
		const after = await Promise.all(watched.map(w => balance(w.address)));
		const target = o.tx.to ?? receipt.contractAddress ?? undefined;
		const stateAfter = target && o.abi ? await readState(url, target, o.abi) : new Map<string, string>();
		const state = [...stateAfter].filter(([k, v]) => (o.tx.to ? stateBefore.get(k) !== v : true)).map(([name, v]) => ({ name, before: stateBefore.get(name) ?? '', after: v }));
		const gasUsed = BigInt(receipt.gasUsed);
		return {
			ok: true, how: 'fork', gasUsed, fee: receipt.effectiveGasPrice ? gasUsed * BigInt(receipt.effectiveGasPrice) : undefined,
			created: receipt.contractAddress ?? undefined,
			balances: watched.map((w, i) => ({ ...w, before: before[i], after: after[i] })).filter(b => b.before !== b.after),
			state: o.tx.to ? state : state.slice(0, 8),
			events: receipt.logs.map(l => o.abis.decodeEvent(l)?.text ?? `event ${l.topics[0]?.slice(0, 10) ?? ''}`),
		};
	} finally {
		o.signal?.removeEventListener('abort', stop);
		stop();
	}
}

const lcai = (wei: bigint) => `${Number(formatEther(wei < 0n ? -wei : wei)).toLocaleString('en-US', { maximumFractionDigits: 6 })} LCAI`;

/** The simulation as a few plain lines for a confirmation dialog. */
export function describeSimulation(s: Simulation): string[] {
	if (!s.ok) {
		return ['This transaction would FAIL.', s.revert?.plain ?? 'The reason could not be read.', 'Nothing would change, but the network fee would still be paid.'];
	}
	const lines = [s.how === 'fork' ? 'Tried on a private copy of the network — it works.' : 'Dry run on the network — it would go through.'];
	if (s.created) {
		lines.push(`A new contract is created${s.state.length ? `, starting with ${s.state.map(v => `${v.name} = ${v.after}`).join(', ')}` : ''}.`);
	}
	for (const b of s.balances) {
		const delta = b.after - b.before;
		lines.push(`${b.label}: ${delta < 0n ? '−' : '+'}${lcai(delta)}${b.label === 'Your wallet' && s.fee ? ` (including about ${lcai(s.fee)} in fees)` : ''}`);
	}
	if (!s.created) {
		for (const v of s.state.slice(0, 6)) {
			lines.push(`${v.name}: ${v.before} → ${v.after}`);
		}
		if (s.state.length > 6) {
			lines.push(`…and ${s.state.length - 6} more values change.`);
		}
	}
	// events this project can name are shown; the rest are only counted
	const known = s.events.filter(e => !/^event (0x|$)/.test(e));
	if (known.length) {
		lines.push(`Events: ${known.slice(0, 3).join('; ')}${known.length > 3 ? ` and ${known.length - 3} more` : ''}`);
	} else if (s.events.length) {
		lines.push(`It announces ${s.events.length} event${s.events.length === 1 ? '' : 's'}.`);
	}
	if (s.how === 'call' && s.fee) {
		lines.push(`Network fee: about ${lcai(s.fee)}`);
	}
	if (s.how === 'fork' && !s.balances.length && !s.state.length && !s.events.length && !s.created) {
		lines.push('No balance, value or event of this contract changes.');
	}
	return lines;
}
