import * as vscode from 'vscode';
import { ChatMessage, InferenceProvider } from '../agent/agent';
import { estimateTokens, recap, sessionNotes } from '../agent/memory';
import { NetworkState } from '../networkState';
import { Wallet } from '../wallet';
import { DelegateNotAuthorizedError, LightchainInference, StatusFn } from './inference';

/**
 * InferenceProvider backed by Lightchain decentralized inference.
 *
 * A Lightchain session keeps the conversation on-chain (the worker rebuilds
 * history from the session's earlier jobs), so each call sends only the newest
 * message; the first prompt of a session also carries the agent instructions.
 *
 * The model only sees a limited window of that history, so later prompts carry
 * short session notes, and once a session outgrows its budget the next prompt
 * starts a fresh session with the instructions and a recap (see agent/memory.ts).
 */
/** Room kept for the model's answer (the worker caps answers at about 1k tokens). */
const REPLY_TOKENS = 1_024;

export function contextBudget(): number {
	return Math.max(2_048, vscode.workspace.getConfiguration('lightchain.ai').get<number>('contextTokens', 8_192));
}

export class LightchainProvider implements InferenceProvider {
	readonly name = 'Lightchain AI';
	private client?: LightchainInference;
	private sentSystem = false;
	private used = 0; // estimated tokens the current session's history holds
	private sentMap?: string; // project map the current session has seen
	/** Called when a new session takes over the conversation (to tell the user). */
	onRefresh?: () => void;
	/** Called for every job submitted on-chain. */
	onJob?: (job: { jobId: string; txHash?: string }) => void;

	constructor(private readonly wallet: Wallet, private readonly network: NetworkState, private readonly model: string) { }

	async *chat(messages: ChatMessage[], signal: AbortSignal, onStatus?: StatusFn): AsyncIterable<string> {
		const account = this.wallet.active;
		if (!account) {
			throw new Error('Connect a wallet to use Lightchain AI.');
		}
		const last = messages[messages.length - 1];
		const earlier = messages.slice(0, -1).filter(m => m.role !== 'system');
		let text = last.content;
		// the session is too full for this prompt and an answer: continue in a fresh one
		if (this.client && this.sentSystem && this.used + estimateTokens(text) + REPLY_TOKENS > contextBudget()) {
			this.client = undefined;
			this.sentSystem = false;
			this.used = 0;
			this.sentMap = undefined;
			onStatus?.('Refreshing context: continuing in a new session…');
			this.onRefresh?.();
		}
		this.client ??= new LightchainInference(this.wallet, account, this.network.current, this.model);
		this.client.onJob = job => this.onJob?.(job);
		const sys = messages.find(m => m.role === 'system');
		const map = sys?.map;
		if (!this.sentSystem) {
			const system = (sys?.content ?? '') + (map ? `\n\nProject context (rules, contracts with their external functions and events, deployed addresses):\n${map}` : '');
			const story = earlier.length ? `Earlier in this conversation (recap — you are continuing it):\n${recap(earlier)}\n\n---\n\n` : '';
			text = `${system}\n\n---\n\n${story}${text}`;
		} else {
			const updated = map && map !== this.sentMap ? `\n\nProject context (updated):\n${map}` : '';
			text = `${sessionNotes(messages)}${updated}\n\n---\n\n${text}`;
		}
		try {
			let answer = 0;
			for await (const delta of this.client.prompt(text, signal, onStatus)) {
				answer += delta.length;
				yield delta;
			}
			this.used += estimateTokens(text) + Math.ceil(answer / 4);
			this.sentSystem = true;
			this.sentMap = map;
		} catch (err) {
			if (err instanceof DelegateNotAuthorizedError && !err.delegate) {
				throw new DelegateNotAuthorizedError(await this.client.delegate().catch(() => undefined));
			}
			throw err;
		}
	}
}
