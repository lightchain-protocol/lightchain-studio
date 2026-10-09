import { toHex, hexToBytes } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { LightchainNetwork } from '../networks';
import { Wallet, WalletAccount } from '../wallet';
import { SIWE_ORIGIN } from '../browserBridge';
// @ts-ignore — vendored (ts-nocheck) module
import { generateSessionKey, importPublicKey, encryptSessionKey, encrypt, decrypt } from './crypto';
// @ts-ignore — vendored (ts-nocheck) module
import { bytesToBase64, base64ToBytes } from './base64';

/**
 * Lightchain decentralized inference client (Node port of lcai-chat-v2's
 * protocol flow, origin/testnet). One instance = one chat session:
 *
 *   auth (SIWE → JWT) → sortition session (consumer-api delegate pays gas) →
 *   session key sealed to worker/disputer (P-256 ECDH + AES-256-GCM) →
 *   per prompt: encrypted blob → delegated submit (debits prepaid credits) →
 *   relay WebSocket → decrypt streamed chunks.
 *
 * Only the newest user text is sent per job; the worker rebuilds history from
 * the session's earlier jobs on-chain.
 */
export class DelegateNotAuthorizedError extends Error {
	constructor(readonly delegate?: string) { super('Lightchain AI is not yet allowed to spend your credits.'); }
}
/** The worker accepted the job but failed or went silent — another model may answer. */
export class WorkerError extends Error {
	constructor(message: string, readonly jobId?: string) { super(message); }
}

/** The relayer's submit transaction failed; nothing was charged and the prompt can be re-sent. */
export class SubmitError extends Error { }

/** Diagnostic sink (the "Lightchain AI" output channel); frames carry only ciphertext. */
export let log: (line: string) => void = () => { };
export function setLog(fn: (line: string) => void): void { log = fn; }

export class InsufficientCreditsError extends Error {
	constructor(message = 'Not enough Lightchain AI credits for this prompt.') { super(message); }
}

interface Frame {
	type: 'chunk' | 'complete' | 'metadata' | 'error' | 'reassignment_required' | 'reassigned' | 'closed';
	kind?: string; jobId?: string | number; sessionId?: string | number; seq?: number;
	payload?: string; code?: string; droppedSeq?: number; message?: string; reason?: string;
}

/** Jobs have a 124 s on-chain deadline; nothing arrives after that. */
const FIRST_FRAME_TIMEOUT_MS = 135_000;
/** Worker went quiet mid-answer (seen with gpt-oss on tool-style prompts: reasoning, then nothing). */
const IDLE_TIMEOUT_MS = 120_000;
const json = { 'content-type': 'application/json' };

export type StatusFn = (status: string, opts?: { walletPrompt?: boolean }) => void;

export class LightchainInference {
	private jwt?: { token: string; exp: number };
	private sessionId?: number;
	private sessionKey?: Uint8Array;
	private modelId?: string;

	get sessionModelId(): string | undefined { return this.modelId; }

	/** Called for every job submitted on-chain (one per model reply). */
	onJob?: (job: { jobId: string; txHash?: string }) => void;

	constructor(
		private readonly wallet: Wallet,
		private readonly account: WalletAccount,
		private readonly network: LightchainNetwork,
		private readonly modelName: string,
	) { }

	get model(): string { return this.modelName; }

	// ---- consumer-api ----------------------------------------------------------

	private status: StatusFn = () => { };

	private get authKey(): string {
		return `${this.network.chainId}:${this.account.address.toLowerCase()}`;
	}

	/**
	 * Lightchain AI sign-in (SIWE → JWT, valid 1 hour). The JWT is kept in the OS
	 * keychain and shared by every chat, so a browser wallet signs at most once
	 * per hour — not per prompt, chat or restart.
	 */
	private async token(): Promise<string> {
		if (this.jwt && this.jwt.exp - Date.now() > 60_000) {
			return this.jwt.token;
		}
		const saved = await this.wallet.getAuth(this.authKey);
		if (saved && saved.exp - Date.now() > 60_000) {
			this.jwt = saved;
			return saved.token;
		}
		const browser = this.account.kind === 'browser';
		this.status(browser ? 'Sign in to Lightchain AI — approve the signature in your browser wallet (once per hour)' : 'Signing in to Lightchain AI…', { walletPrompt: browser });
		const api = this.network.consumerApiUrl;
		let message: string;
		if (browser) {
			// consumer-api only accepts the domain localhost:3000 but lets us state
			// what the signature is for. The bridge page is served from that origin
			// when the port is free, so the wallet shows no domain warning.
			const nr = await fetch(`${api}/api/auth/nonce`, { signal: AbortSignal.timeout(20_000) });
			if (!nr.ok) {
				throw new Error(`Lightchain AI sign-in unavailable (${nr.status}).`);
			}
			const { nonce } = await nr.json() as { nonce: string };
			message = createSiweMessage({
				address: this.account.address,
				chainId: this.network.chainId,
				domain: new URL(SIWE_ORIGIN).host,
				uri: SIWE_ORIGIN,
				version: '1',
				nonce,
				statement: 'Sign in to Lightchain AI from Lightchain Studio. This does not send a transaction or cost gas.',
				issuedAt: new Date(),
				expirationTime: new Date(Date.now() + 5 * 60_000),
			});
		} else {
			const ch = await fetch(`${api}/api/auth/challenge?address=${this.account.address}`, { signal: AbortSignal.timeout(20_000) });
			if (!ch.ok) {
				throw new Error(`Lightchain AI sign-in unavailable (${ch.status}).`);
			}
			message = (await ch.json() as { message: string }).message;
		}
		const signature = await this.wallet.signMessage(this.account, this.network, message, 'Sign in to Lightchain AI · valid for 1 hour · no gas');
		const vr = await fetch(`${api}/api/auth/verify`, { method: 'POST', headers: json, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(30_000) });
		const body = await vr.json().catch(() => ({})) as { token?: string; expiresAt?: string; message?: string };
		if (!vr.ok || !body.token) {
			throw new Error(`Lightchain AI sign-in failed: ${body.message ?? vr.status}`);
		}
		this.status('Signed in');
		this.jwt = { token: body.token, exp: body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 55 * 60_000 };
		await this.wallet.setAuth(this.authKey, this.jwt);
		return body.token;
	}

	private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; data: T }> {
		const res = await fetch(`${this.network.consumerApiUrl}${path}`, {
			method,
			headers: { ...json, Authorization: `Bearer ${await this.token()}` },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 401) {
			this.jwt = undefined; // expired or revoked: next call signs in again
			void this.wallet.setAuth(this.authKey, undefined);
		}
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* plain text */ }
		return { status: res.status, data };
	}

	/** Delegate address the consumer-api submits from (for credit authorization). */
	async delegate(): Promise<string | undefined> {
		const r = await this.api<{ delegate?: string }>('GET', '/api/balance');
		return r.data?.delegate;
	}

	// ---- session --------------------------------------------------------------------

	private async ensureSession(): Promise<void> {
		if (this.sessionId !== undefined && this.sessionKey) {
			return;
		}
		const models = await fetch(`${this.network.consumerApiUrl}/api/models`, { signal: AbortSignal.timeout(20_000) }).then(r => r.json()) as { models: Array<{ id: string; name: string }> };
		const model = models.models.find(m => m.id === this.modelName || m.name === this.modelName);
		if (!model) {
			throw new Error(`Model "${this.modelName}" is not served on Lightchain ${this.network.label}. Available: ${models.models.map(m => m.name).join(', ')}`);
		}
		this.modelId = model.id;
		this.status(`Finding a ${model.name} worker…`);

		const req = await this.api<any>('POST', '/api/sessions/sortition/request', { modelId: model.id }, 150_000);
		if (req.status === 408 || req.status === 503 || req.status === 504) {
			throw new Error(`No Lightchain worker is available for ${model.name} right now. Try again or pick another model.`);
		}
		if (req.status === 403) {
			// consumer-api requires JobRegistry.setDelegateAuthorization(delegate, true) before sessions
			throw new DelegateNotAuthorizedError(req.data?.delegate);
		}
		if (req.status === 402) {
			throw new InsufficientCreditsError(req.data?.message);
		}
		if (req.status >= 400) {
			throw new Error(`Could not start a Lightchain AI session (${req.status}): ${req.data?.message ?? ''}`);
		}
		this.status('Opening an encrypted session…');
		const key: Uint8Array = await generateSessionKey();
		const encW = toHex(await encryptSessionKey(key, await importPublicKey(hexToBytes(req.data.workerEncryptionKey))));
		const encD = req.data.disputerEncryptionKey && req.data.disputerEncryptionKey !== '0x'
			? toHex(await encryptSessionKey(key, await importPublicKey(hexToBytes(req.data.disputerEncryptionKey))))
			: '0x';
		const keys = await this.api<any>('POST', `/api/sessions/sortition/${req.data.reqId}/keys`, { encWorkerKey: encW, encDisputerKey: encD }, 120_000);
		if (keys.status >= 400 || keys.data?.sessionId === undefined) {
			throw new Error(`Could not open the Lightchain AI session (${keys.status}): ${keys.data?.message ?? ''}`);
		}
		this.sessionId = Number(keys.data.sessionId);
		this.sessionKey = key;
	}

	private async relayToken(): Promise<string> {
		const started = Date.now();
		for (let n = 1; Date.now() - started < 30_000; n++) {
			const r = await this.api<any>('GET', `/api/sessions/${this.sessionId}/token`);
			if (r.status === 200 && r.data?.token) {
				return r.data.token;
			}
			if (r.status !== 202) {
				throw new Error(`Relay token unavailable (${r.status}).`);
			}
			await new Promise(res => setTimeout(res, Math.min(1000 * n, 4000)));
		}
		throw new Error('Timed out waiting for the Lightchain relay token.');
	}

	// ---- prompt -------------------------------------------------------------------

	async *prompt(text: string, signal: AbortSignal, onStatus?: StatusFn): AsyncGenerator<string> {
		this.status = onStatus ?? (() => { });
		await this.ensureSession();
		this.status('Connecting to the Lightchain relay…');
		const relayToken = await this.relayToken();
		const sessionKey = this.sessionKey!;

		// Subscribe before submitting so no frame is missed.
		const url = new URL(this.network.relayUrl);
		url.searchParams.set('token', relayToken);
		const ws = new WebSocket(url.toString());
		const frames: Frame[] = [];
		let wake: (() => void) | undefined;
		let closed = false;
		ws.onmessage = ev => { try { frames.push(JSON.parse(String(ev.data))); wake?.(); } catch { /* ignore */ } };
		ws.onclose = () => { closed = true; wake?.(); };
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('Could not connect to the Lightchain relay.'));
			setTimeout(() => reject(new Error('Lightchain relay connection timed out.')), 20_000);
		});
		const onAbort = () => ws.close(1000);
		signal.addEventListener('abort', onAbort);

		try {
			this.status('Encrypting and uploading your prompt…');
			const ct: Uint8Array = await encrypt(sessionKey, new TextEncoder().encode(text));
			const blob = await this.api<any>('POST', '/api/blobs', { data: bytesToBase64(ct), sessionId: String(this.sessionId) }, 120_000);
			const blobHash = blob.data?.blobHashes?.[0];
			if (blob.status >= 400 || !blobHash) {
				throw new Error(`Prompt upload failed (${blob.status}): ${blob.data?.message ?? ''}`);
			}
			this.status('Submitting the job on-chain…');
			let sub = await this.api<any>('POST', `/api/sessions/${this.sessionId}/messages`, { blobHash }, 120_000);
			if (sub.status >= 500) {
				// The relayer's submit tx can revert (e.g. a gas limit set too tight); nothing is
				// charged then, so one automatic retry is safe.
				log(`submit failed (${sub.status}): ${sub.data?.message ?? ''} — retrying once`);
				this.status('Submitting the job again…');
				await new Promise(r => setTimeout(r, 2000));
				sub = await this.api<any>('POST', `/api/sessions/${this.sessionId}/messages`, { blobHash }, 120_000);
			}
			if (sub.status === 403) {
				throw new DelegateNotAuthorizedError(sub.data?.delegate);
			}
			if (sub.status === 402) {
				throw new InsufficientCreditsError(sub.data?.message);
			}
			if (sub.status >= 500) {
				log(`submit failed again (${sub.status}): ${sub.data?.message ?? ''}`);
				throw new SubmitError('Lightchain couldn\'t submit this prompt on-chain (a network-side failure). No credits were charged.');
			}
			if (sub.status >= 400) {
				throw new Error(`Prompt submission failed (${sub.status}): ${sub.data?.message ?? ''}`);
			}
			const jobId = String(sub.data.jobId);
			this.onJob?.({ jobId, txHash: typeof sub.data.txHash === 'string' ? sub.data.txHash : undefined });
			this.status(`Job ${jobId} submitted — waiting for the worker…`);

			let acc = '';
			const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
			let gotFrame = false;
			let lastFrameAt = Date.now();
			while (!signal.aborted) {
				const f = frames.shift();
				if (!f) {
					if (closed) {
						throw new Error('The Lightchain relay closed before the answer finished.');
					}
					if (!gotFrame && Date.now() > deadline) {
						throw new WorkerError(`No response from the ${this.modelName} worker in time (job ${jobId}).`, jobId);
					}
					if (gotFrame && Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) {
						throw new WorkerError(`The ${this.modelName} worker stopped responding (job ${jobId}).`, jobId);
					}
					await new Promise<void>(r => { wake = r; setTimeout(r, 1000); });
					continue;
				}
				if (f.type === 'reassignment_required' || f.type === 'closed') {
					throw new Error(`The Lightchain session ended (${f.reason ?? f.type}). Start a new chat.`);
				}
				if (f.jobId !== undefined && String(f.jobId) !== jobId) {
					continue; // another job's frames
				}
				gotFrame = true;
				lastFrameAt = Date.now();
				if (f.type === 'error') {
					if (f.code === 'RATE_LIMITED' && (f.droppedSeq ?? 0) > 0) {
						continue;
					}
					log(`job ${jobId} error frame: ${JSON.stringify({ ...f, payload: f.payload ? '<ciphertext>' : undefined })}`);
					// consumer-api sends error frames without a message (lcai-chat-v2 handles it the same way)
					const detail = f.message || f.reason || f.code;
					throw new WorkerError(`The ${this.modelName} worker reported an error while answering job ${jobId}${detail ? ` (${detail})` : ''}.`, jobId);
				}
				if (f.type === 'metadata' || !f.payload || (f.kind && f.kind !== 'text' && f.type !== 'complete')) {
					continue;
				}
				const plain = new TextDecoder().decode(await decrypt(sessionKey, base64ToBytes(f.payload)));
				if (f.type === 'complete') {
					const full = unwrapEnvelope(plain);
					if (!full.trim() && !acc.trim()) {
						throw new WorkerError(`The ${this.modelName} worker returned an empty answer (job ${jobId}).`, jobId);
					}
					if (full.startsWith(acc)) {
						yield full.slice(acc.length);
					}
					return;
				}
				if (f.seq === 1 && acc) {
					acc = ''; // worker retried the job — restart the stream
				}
				acc += plain;
				yield plain;
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			ws.close(1000);
		}
	}
}

/** `{v:2, answer, searchContext}` envelope → answer; otherwise the text itself. */
function unwrapEnvelope(text: string): string {
	try {
		const o = JSON.parse(text);
		if (o && typeof o === 'object' && typeof o.answer === 'string') {
			return o.answer;
		}
	} catch { /* plain text */ }
	return text;
}
