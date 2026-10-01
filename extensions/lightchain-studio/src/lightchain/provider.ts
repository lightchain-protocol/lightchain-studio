import { ChatMessage, InferenceProvider } from '../agent/agent';
import { NetworkState } from '../networkState';
import { Wallet } from '../wallet';
import { DelegateNotAuthorizedError, LightchainInference, StatusFn } from './inference';

/**
 * InferenceProvider backed by Lightchain decentralized inference.
 *
 * A Lightchain session keeps the conversation on-chain (the worker rebuilds
 * history from the session's earlier jobs), so each call sends only the newest
 * message; the first prompt of a session also carries the agent instructions.
 */
export class LightchainProvider implements InferenceProvider {
	readonly name = 'Lightchain AI';
	private client?: LightchainInference;
	private sentSystem = false;

	constructor(private readonly wallet: Wallet, private readonly network: NetworkState, private readonly model: string) { }

	async *chat(messages: ChatMessage[], signal: AbortSignal, onStatus?: StatusFn): AsyncIterable<string> {
		const account = this.wallet.active;
		if (!account) {
			throw new Error('Connect a wallet to use Lightchain AI.');
		}
		this.client ??= new LightchainInference(this.wallet, account, this.network.current, this.model);
		const last = messages[messages.length - 1];
		let text = last.content;
		if (!this.sentSystem) {
			const system = messages.find(m => m.role === 'system')?.content ?? '';
			text = `${system}\n\n---\n\n${text}`;
		}
		try {
			yield* this.client.prompt(text, signal, onStatus);
			this.sentSystem = true;
		} catch (err) {
			if (err instanceof DelegateNotAuthorizedError && !err.delegate) {
				throw new DelegateNotAuthorizedError(await this.client.delegate().catch(() => undefined));
			}
			throw err;
		}
	}
}
