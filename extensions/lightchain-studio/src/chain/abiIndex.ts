import { Abi, AbiEvent, AbiFunction, Hex, decodeAbiParameters, decodeErrorResult, decodeEventLog, decodeFunctionData, toEventSelector, toFunctionSelector } from 'viem';

/**
 * Every ABI the project knows (Foundry artifacts in out/), searchable by what
 * shows up on chain: call data, revert data and event logs. Used to turn raw
 * hex into "withdraw(amount: 5)", "NotOwner(caller: 0x…)" and "Withdrawn(…)".
 */
export interface KnownContract { name: string; abi: Abi; source?: string }
export interface DecodedCall { contract?: string; name: string; signature: string; args: { name: string; value: string }[]; text: string }
export interface DecodedEvent { contract?: string; name: string; args: { name: string; value: string }[]; text: string }
export interface DecodedRevert { kind: 'reason' | 'panic' | 'custom' | 'empty' | 'unknown'; name?: string; text: string; /** what it means for someone who does not read Solidity */ plain: string }

const PANICS: Record<number, string> = {
	0x01: 'an assert() check failed',
	0x11: 'a number went below zero or above its maximum (arithmetic overflow or underflow)',
	0x12: 'a division by zero',
	0x21: 'a value outside the allowed options of an enum',
	0x22: 'badly stored data was read',
	0x31: 'pop() was called on an empty list',
	0x32: 'a list was read past its end (index out of bounds)',
	0x41: 'too much memory was requested',
	0x51: 'a function that was never set was called',
};

/** A value as people read it: addresses and numbers plain, long data shortened. */
export function show(value: unknown): string {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (typeof value === 'string') {
		return value.length > 74 ? `${value.slice(0, 34)}…${value.slice(-8)} (${(value.length - 2) / 2} bytes)` : value;
	}
	if (Array.isArray(value)) {
		return `[${value.map(show).join(', ')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value).map(([k, v]) => `${k}: ${show(v)}`).join(', ')}}`;
	}
	return String(value);
}

function named(inputs: readonly { name?: string }[], values: readonly unknown[] | Record<string, unknown> | undefined): { name: string; value: string }[] {
	if (!values) {
		return [];
	}
	return Array.isArray(values)
		? values.map((v, i) => ({ name: inputs[i]?.name || `arg${i}`, value: show(v) }))
		: Object.entries(values as Record<string, unknown>).map(([k, v]) => ({ name: k, value: show(v) }));
}

const list = (args: { name: string; value: string }[]) => args.map(a => `${a.name}: ${a.value}`).join(', ');

export class AbiIndex {
	private contracts: KnownContract[] = [];
	private fns = new Map<string, { contract: string; fn: AbiFunction }[]>();
	private events = new Map<string, { contract: string; event: AbiEvent }[]>();

	constructor(contracts: KnownContract[] = []) {
		contracts.forEach(c => this.add(c));
	}

	get size(): number {
		return this.contracts.length;
	}

	get all(): KnownContract[] {
		return this.contracts;
	}

	byName(name: string): KnownContract | undefined {
		return this.contracts.find(c => c.name === name);
	}

	add(c: KnownContract): void {
		this.contracts.push(c);
		for (const item of c.abi) {
			try {
				if (item.type === 'function') {
					const sel = toFunctionSelector(item);
					this.fns.set(sel, [...(this.fns.get(sel) ?? []), { contract: c.name, fn: item }]);
				} else if (item.type === 'event') {
					const topic = toEventSelector(item);
					this.events.set(topic, [...(this.events.get(topic) ?? []), { contract: c.name, event: item }]);
				}
			} catch { /* an ABI entry viem cannot hash: skip it */ }
		}
	}

	/** Call data → the function and its arguments. `prefer`: the contract it was sent to, when known. */
	decodeCall(data: Hex | undefined, prefer?: string): DecodedCall | undefined {
		if (!data || data.length < 10) {
			return undefined;
		}
		const hits = this.fns.get(data.slice(0, 10).toLowerCase());
		const hit = hits?.find(h => h.contract === prefer) ?? hits?.[0];
		if (!hit) {
			return undefined;
		}
		try {
			const { args } = decodeFunctionData({ abi: [hit.fn], data });
			const a = named(hit.fn.inputs, args);
			return { contract: hit.contract, name: hit.fn.name, signature: `${hit.fn.name}(${hit.fn.inputs.map(i => i.type).join(',')})`, args: a, text: `${hit.fn.name}(${list(a)})` };
		} catch {
			return { contract: hit.contract, name: hit.fn.name, signature: hit.fn.name, args: [], text: `${hit.fn.name}(…)` };
		}
	}

	decodeEvent(log: { topics: readonly Hex[] | Hex[]; data: Hex }): DecodedEvent | undefined {
		const hits = log.topics[0] ? this.events.get(log.topics[0].toLowerCase()) : undefined;
		for (const hit of hits ?? []) {
			try {
				const d = decodeEventLog({ abi: [hit.event], topics: log.topics as [Hex, ...Hex[]], data: log.data });
				const a = named(hit.event.inputs, d.args as unknown as Record<string, unknown>);
				return { contract: hit.contract, name: hit.event.name, args: a, text: `${hit.event.name}(${list(a)})` };
			} catch { /* same signature, different indexed layout: try the next */ }
		}
		return undefined;
	}

	/** Revert data → why it failed, in the contract's words and in plain ones. */
	decodeRevert(data: Hex | undefined): DecodedRevert {
		if (!data || data === '0x') {
			return { kind: 'empty', text: 'reverted without a reason', plain: 'The contract refused the call without saying why. Usually a require() with no message failed, the function does not exist, or it was sent LCAI it cannot accept.' };
		}
		const selector = data.slice(0, 10).toLowerCase();
		try {
			if (selector === '0x08c379a0') {
				const [reason] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`);
				return { kind: 'reason', text: reason, plain: `The contract stopped with the message "${reason}".` };
			}
			if (selector === '0x4e487b71') {
				const [code] = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}`);
				const what = PANICS[Number(code)] ?? `an internal error (code 0x${Number(code).toString(16)})`;
				return { kind: 'panic', text: `Panic(0x${Number(code).toString(16).padStart(2, '0')})`, plain: `Solidity stopped the call because of ${what}.` };
			}
		} catch { /* fall through to custom errors */ }
		for (const c of this.contracts) {
			try {
				const d = decodeErrorResult({ abi: c.abi, data });
				const item = c.abi.find(x => x.type === 'error' && x.name === d.errorName);
				const a = named(item && 'inputs' in item ? item.inputs : [], d.args as readonly unknown[] | undefined);
				const words = d.errorName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
				return { kind: 'custom', name: d.errorName, text: `${d.errorName}(${list(a)})`, plain: `The contract stopped with its own error "${words}"${a.length ? ` (${list(a)})` : ''}.` };
			} catch { /* not this contract's error */ }
		}
		return { kind: 'unknown', text: `error ${selector}`, plain: `The contract stopped with an error this project does not know (${selector}). It probably comes from another contract that was called.` };
	}
}

/** Zero-argument read functions: the contract's visible state. */
export function stateReaders(abi: Abi): AbiFunction[] {
	return abi.filter((x): x is AbiFunction => x.type === 'function' && (x.stateMutability === 'view' || x.stateMutability === 'pure') && x.inputs.length === 0 && x.outputs.length > 0);
}
