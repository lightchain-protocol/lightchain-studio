import * as vscode from 'vscode';
import { encodeFunctionData, formatEther, parseAbi, parseEther, type Hex } from 'viem';
import { LightchainNetwork } from './networks';
import { Wallet, WalletAccount } from './wallet';

/**
 * Lightchain AI credits = the prepaid LCAI balance on JobRegistry that pays for
 * inference jobs, exactly as lcai-chat-v2 shows it (hooks/use-prepaid-balance.ts).
 *
 * - balance:   JobRegistry.prepaidBalanceOf(user)   (public read)
 * - top up:    JobRegistry.deposit() {value}         (one tx, no sign-in)
 * - withdraw:  JobRegistry.withdrawBalance(amount)
 *
 * Authorizing the consumer-api delegate to spend credits (setDelegateAuthorization /
 * setDelegateAllowance) belongs to the Lightchain AI client, which signs in to the
 * consumer-api anyway; buying credits must not require a sign-in.
 */
const JOB_REGISTRY_ABI = parseAbi([
	'function prepaidBalanceOf(address user) view returns (uint256)',
	'function isDelegateAuthorized(address user, address delegate) view returns (bool)',
	'function delegateAllowance(address user, address delegate) view returns (uint256)',
	'function deposit() payable',
	'function withdrawBalance(uint256 amount)',
	'function setDelegateAuthorization(address delegate, bool authorized)',
	'function setDelegateAllowance(address delegate, uint256 allowance)',
]);

/** Escrowed per Lightchain AI job on testnet today (JobRegistry fee). */
export const JOB_FEE_LCAI = 0.02;

/**
 * What one request costs in credits on a network. The registry has no getter for it, so these are
 * measured: testnet 0.02; mainnet 0.05 (5 jobs took 0.25 LCAI on 2026-10-13).
 */
export function jobFee(network: { id: string }): number {
	return network.id === 'mainnet' ? 0.05 : JOB_FEE_LCAI;
}

export interface CreditsSnapshot {
	credits: bigint;      // prepaid LCAI (wei)
	walletBalance: bigint;  // native LCAI (wei)
}

export class Credits implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly wallet: Wallet) { }

	async read(account: WalletAccount, network: LightchainNetwork): Promise<CreditsSnapshot> {
		const client = this.wallet.publicClient(network);
		const [credits, walletBalance] = await Promise.all([
			client.readContract({ address: network.jobRegistry, abi: JOB_REGISTRY_ABI, functionName: 'prepaidBalanceOf', args: [account.address] }),
			client.getBalance({ address: account.address }),
		]);
		return { credits, walletBalance };
	}

	/** Deposit `amountLcai` as Lightchain AI credits (JobRegistry.deposit). */
	async topUp(account: WalletAccount, network: LightchainNetwork, amountLcai: string): Promise<Hex> {
		const hash = await this.wallet.sendTransaction(account, network, {
			to: network.jobRegistry,
			data: encodeFunctionData({ abi: JOB_REGISTRY_ABI, functionName: 'deposit' }),
			value: parseEther(amountLcai),
		}, `Add ${amountLcai} LCAI of Lightchain AI credits`);
		this._onDidChange.fire();
		return hash;
	}

	/**
	 * Let Lightchain AI spend credits: authorize the consumer-api delegate and set its
	 * allowance to the current prepaid balance (same as lcai-chat-v2's authorizeDelegate).
	 */
	async enableForAi(account: WalletAccount, network: LightchainNetwork, delegate: `0x${string}`): Promise<void> {
		const client = this.wallet.publicClient(network);
		const authorized = await client.readContract({ address: network.jobRegistry, abi: JOB_REGISTRY_ABI, functionName: 'isDelegateAuthorized', args: [account.address, delegate] });
		if (!authorized) {
			await this.wallet.sendTransaction(account, network, {
				to: network.jobRegistry,
				data: encodeFunctionData({ abi: JOB_REGISTRY_ABI, functionName: 'setDelegateAuthorization', args: [delegate, true] }),
			}, 'Allow Lightchain AI to pay for your requests from your credits (one time)');
		}
		const balance = await client.readContract({ address: network.jobRegistry, abi: JOB_REGISTRY_ABI, functionName: 'prepaidBalanceOf', args: [account.address] });
		await this.wallet.sendTransaction(account, network, {
			to: network.jobRegistry,
			data: encodeFunctionData({ abi: JOB_REGISTRY_ABI, functionName: 'setDelegateAllowance', args: [delegate, balance] }),
		}, 'Set how much Lightchain AI may spend: your current credits, never more');
		this._onDidChange.fire();
	}

	async withdraw(account: WalletAccount, network: LightchainNetwork, amountLcai: string): Promise<Hex> {
		const hash = await this.wallet.sendTransaction(account, network, {
			to: network.jobRegistry,
			data: encodeFunctionData({ abi: JOB_REGISTRY_ABI, functionName: 'withdrawBalance', args: [parseEther(amountLcai)] }),
		}, `Move ${amountLcai} LCAI of credits back to your wallet`);
		this._onDidChange.fire();
		return hash;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

export function formatLcai(wei: bigint, maxFractionDigits = 4): string {
	return Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}
