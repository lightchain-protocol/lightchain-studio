import * as vscode from 'vscode';
import { parseAbi, encodeFunctionData } from 'viem';
import { LightchainNetwork } from '../networks';
import { Wallet, WalletAccount } from '../wallet';

/**
 * Fees of jobs whose worker accepted and never answered stay escrowed until the
 * JobRegistry's no-fault window opens (deadline + resolution timeout, 48 h on
 * testnet). We remember such jobs and offer to reclaim them once
 * settleStuckJob(jobId) would succeed; the fee goes back to the user's credits.
 */
const KEY = 'lightchain.ai.stuckJobs';
const ABI = parseAbi([
	'struct Job { uint256 sessionId; address worker; uint8 state; uint256 escrowedFee; bytes32 promptBlobHash; bytes32 responseBlobHash; uint256 submittedAt; uint256 ackTimestamp; uint256 completedAt; uint256 deadline; address disputeFiler; uint256 disputeBond; bytes32 reExecutionBlobHash; uint256 similarityScore; uint256 disputeCreatedAt; bytes32 responseCiphertextHash; uint256 submitBlockNumber; uint256 completionBlockNumber; }',
	'function getJob(uint256 jobId) view returns (Job)',
	'function settleStuckJob(uint256 jobId)',
]);
const OPEN = new Set([0, 1]); // Submitted, Acknowledged

interface Stuck { jobId: string; network: string; account: string }

export interface StuckSummary { claimable: string[]; fee: bigint; waiting: number }

export class StuckJobs {
	constructor(private readonly memento: vscode.Memento, private readonly wallet: Wallet) { }

	private list(): Stuck[] {
		return this.memento.get<Stuck[]>(KEY, []);
	}

	remember(jobId: string, network: LightchainNetwork, account: WalletAccount): void {
		const all = this.list();
		if (!all.some(s => s.jobId === jobId && s.network === network.id)) {
			void this.memento.update(KEY, [...all, { jobId, network: network.id, account: account.address.toLowerCase() }].slice(-50));
		}
	}

	/** Which remembered jobs can be reclaimed now; drops the ones that settled on their own. */
	async summary(network: LightchainNetwork, account: WalletAccount): Promise<StuckSummary> {
		const client = this.wallet.publicClient(network);
		const mine = this.list().filter(s => s.network === network.id && s.account === account.address.toLowerCase());
		const settled = new Set<string>();
		const result: StuckSummary = { claimable: [], fee: 0n, waiting: 0 };
		for (const s of mine) {
			try {
				const job = await client.readContract({ address: network.jobRegistry, abi: ABI, functionName: 'getJob', args: [BigInt(s.jobId)] });
				if (!OPEN.has(Number(job.state)) || job.escrowedFee === 0n) {
					settled.add(s.jobId);
					continue;
				}
				try {
					await client.simulateContract({ account: account.address, address: network.jobRegistry, abi: ABI, functionName: 'settleStuckJob', args: [BigInt(s.jobId)] });
					result.claimable.push(s.jobId);
					result.fee += job.escrowedFee;
				} catch {
					result.waiting++; // the no-fault window is not open yet
				}
			} catch { /* RPC hiccup: keep it for next time */ }
		}
		if (settled.size) {
			await this.memento.update(KEY, this.list().filter(s => !(s.network === network.id && settled.has(s.jobId))));
		}
		return result;
	}

	/** Settle every claimable job (one transaction each); returns how many succeeded. */
	async reclaim(network: LightchainNetwork, account: WalletAccount, jobIds: string[]): Promise<number> {
		let done = 0;
		for (const id of jobIds) {
			await this.wallet.sendTransaction(account, network, {
				to: network.jobRegistry,
				data: encodeFunctionData({ abi: ABI, functionName: 'settleStuckJob', args: [BigInt(id)] }),
			}, `Reclaim the fee of stalled Lightchain AI job ${id}`);
			done++;
		}
		await this.memento.update(KEY, this.list().filter(s => !(s.network === network.id && jobIds.includes(s.jobId))));
		return done;
	}
}
