import * as vscode from 'vscode';
import { parseAbiItem, type PublicClient } from 'viem';
import { LightchainNetwork } from './networks';

/**
 * What an account has spent on Lightchain AI, read from JobRegistry's own events
 * (no Lightchain server involved):
 *
 *   spent = deposited + refunds credited back − withdrawn − current balance
 *
 * Deposits, withdrawals and refunds are events indexed by user; job fees are
 * debited from the prepaid balance without a per-user event, so the difference
 * is what jobs consumed. Totals are cached per account with the last block read,
 * so later reads only scan new blocks.
 */
const EVENTS = {
	deposited: parseAbiItem('event Deposited(address indexed user, uint256 amount, uint256 newBalance)'),
	withdrew: parseAbiItem('event Withdrew(address indexed user, uint256 amount, uint256 newBalance)'),
	refund: parseAbiItem('event RefundCreditedToBalance(address indexed user, uint256 indexed jobId, uint256 amount)'),
	bond: parseAbiItem('event DisputeBondCreditedToBalance(address indexed user, uint256 indexed jobId, uint256 amount)'),
};
const KEY = 'lightchain.usage.v1';

interface Totals { deposited: string; withdrawn: string; refunded: string; block: string }

export interface Usage { deposited: bigint; withdrawn: bigint; refunded: bigint; spent: bigint }

export class UsageReader {
	constructor(private readonly memento: vscode.Memento) { }

	async read(client: PublicClient, network: LightchainNetwork, address: `0x${string}`, balance: bigint): Promise<Usage> {
		const id = `${network.id}:${address.toLowerCase()}`;
		const all = this.memento.get<Record<string, Totals>>(KEY, {});
		const saved = all[id];
		let deposited = BigInt(saved?.deposited ?? 0), withdrawn = BigInt(saved?.withdrawn ?? 0), refunded = BigInt(saved?.refunded ?? 0);
		const fromBlock = saved ? BigInt(saved.block) + 1n : 0n;
		const head = await client.getBlockNumber();
		if (fromBlock <= head) {
			const logs = (event: typeof EVENTS[keyof typeof EVENTS]) => client.getLogs({ address: network.jobRegistry, event, args: { user: address }, fromBlock, toBlock: head });
			const [d, w, r, b] = await Promise.all([logs(EVENTS.deposited), logs(EVENTS.withdrew), logs(EVENTS.refund), logs(EVENTS.bond)]);
			const sum = (list: { args: { amount?: bigint } }[]) => list.reduce((n, l) => n + (l.args.amount ?? 0n), 0n);
			deposited += sum(d);
			withdrawn += sum(w);
			refunded += sum(r) + sum(b);
			await this.memento.update(KEY, { ...all, [id]: { deposited: String(deposited), withdrawn: String(withdrawn), refunded: String(refunded), block: String(head) } });
		}
		const spent = deposited + refunded - withdrawn - balance;
		return { deposited, withdrawn, refunded, spent: spent > 0n ? spent : 0n };
	}
}
