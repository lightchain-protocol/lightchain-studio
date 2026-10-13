import * as vscode from 'vscode';
import { createPublicClient, createWalletClient, formatEther, http, isAddress, isHex, toHex, type Hex } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { LightchainNetwork, toViemChain } from './networks';
import { BrowserBridge } from './browserBridge';

/**
 * Lightchain Studio wallet: local key registry + browser wallets (via BrowserBridge).
 *
 * Local private keys live only in SecretStorage (OS keychain via Electron
 * safeStorage); globalState holds non-secret metadata. Keys never reach a
 * webview. Browser-wallet accounts sign in the user's own wallet extension.
 */
export interface WalletAccount {
	id: string;
	name: string;
	address: `0x${string}`;
	kind: 'local' | 'browser';
}

export interface TxRequest {
	to: `0x${string}`;
	data?: Hex;
	value?: bigint;
}

const ACCOUNTS_KEY = 'lightchain.wallet.accounts';
const ACTIVE_KEY = 'lightchain.wallet.active';
const BROWSER_ID = 'browser';
const BROWSER_KEY = 'lightchain.wallet.browser';
const secretKey = (id: string) => `lightchain.wallet.key.${id}`;

export class Wallet implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, readonly bridge: BrowserBridge) {
		// The wallet extension switched accounts (or disconnected) while the page was open.
		this.disposables.push(bridge.onDidChangeAccount(async info => {
			await context.globalState.update(BROWSER_KEY, info ? { address: info.address, wallet: info.wallet } : undefined);
			this._onDidChange.fire();
		}));
	}

	/** Local accounts (the key registry). */
	get accounts(): WalletAccount[] {
		return this.context.globalState.get<Omit<WalletAccount, 'kind'>[]>(ACCOUNTS_KEY, []).map(a => ({ ...a, kind: 'local' as const }));
	}

	/** The connected browser wallet account (remembered across restarts). */
	get browserAccount(): WalletAccount | undefined {
		const saved = this.context.globalState.get<{ address: `0x${string}`; wallet: string }>(BROWSER_KEY);
		return saved ? { id: BROWSER_ID, name: saved.wallet, address: saved.address, kind: 'browser' } : undefined;
	}

	get all(): WalletAccount[] {
		const browser = this.browserAccount;
		return browser ? [browser, ...this.accounts] : this.accounts;
	}

	get active(): WalletAccount | undefined {
		const id = this.context.globalState.get<string>(ACTIVE_KEY);
		return this.all.find(a => a.id === id) ?? this.all[0];
	}

	// ---- local keys ------------------------------------------------------------

	async create(name: string): Promise<WalletAccount> {
		return this.add(name, generatePrivateKey());
	}

	async importKey(name: string, privateKey: string): Promise<WalletAccount> {
		const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
		if (!isHex(key) || key.length !== 66) {
			throw new Error('A private key is 32 bytes of hex (64 characters, optional 0x prefix).');
		}
		return this.add(name, key);
	}

	/** BIP-39 recovery phrase → the account at m/44'/60'/0'/0/<index>. Only that key is stored, never the phrase. */
	async importMnemonic(name: string, phrase: string, index = 0): Promise<WalletAccount> {
		const words = phrase.trim().toLowerCase().split(/\s+/);
		if (![12, 15, 18, 21, 24].includes(words.length)) {
			throw new Error('A recovery phrase has 12, 15, 18, 21 or 24 words.');
		}
		let key: Uint8Array | null | undefined;
		try {
			key = mnemonicToAccount(words.join(' '), { addressIndex: index }).getHdKey().privateKey;
		} catch {
			throw new Error('That recovery phrase is not valid (check the words and their order).');
		}
		if (!key) {
			throw new Error('Could not derive a key from that recovery phrase.');
		}
		return this.add(name, toHex(key));
	}

	/** Address of the account a phrase would import, to show before importing. */
	static mnemonicAddress(phrase: string, index = 0): `0x${string}` | undefined {
		try {
			return mnemonicToAccount(phrase.trim().toLowerCase().split(/\s+/).join(' '), { addressIndex: index }).address;
		} catch {
			return undefined;
		}
	}

	private async add(name: string, privateKey: Hex): Promise<WalletAccount> {
		const address = privateKeyToAccount(privateKey).address;
		const existing = this.accounts.find(a => a.address.toLowerCase() === address.toLowerCase());
		if (existing) {
			throw new Error(`This key is already in the wallet as "${existing.name}".`);
		}
		const id = `${Date.now().toString(36)}-${address.slice(2, 8).toLowerCase()}`;
		await this.context.secrets.store(secretKey(id), privateKey);
		const stored = this.context.globalState.get<Omit<WalletAccount, 'kind'>[]>(ACCOUNTS_KEY, []);
		await this.context.globalState.update(ACCOUNTS_KEY, [...stored, { id, name, address }]);
		await this.context.globalState.update(ACTIVE_KEY, id);
		this._onDidChange.fire();
		return { id, name, address, kind: 'local' };
	}

	async select(id: string): Promise<void> {
		await this.context.globalState.update(ACTIVE_KEY, id);
		this._onDidChange.fire();
	}

	async remove(id: string): Promise<void> {
		if (id === BROWSER_ID) {
			await this.context.globalState.update(BROWSER_KEY, undefined);
		} else {
			await this.context.secrets.delete(secretKey(id));
			const stored = this.context.globalState.get<Omit<WalletAccount, 'kind'>[]>(ACCOUNTS_KEY, []);
			await this.context.globalState.update(ACCOUNTS_KEY, stored.filter(a => a.id !== id));
		}
		if (this.context.globalState.get<string>(ACTIVE_KEY) === id) {
			await this.context.globalState.update(ACTIVE_KEY, this.all[0]?.id);
		}
		this._onDidChange.fire();
	}

	/** Cached Lightchain AI sign-in (JWT) for an account on a network, kept in the OS keychain. */
	async getAuth(key: string): Promise<{ token: string; exp: number } | undefined> {
		try {
			const raw = await this.context.secrets.get(`lightchain.auth.${key}`);
			return raw ? JSON.parse(raw) : undefined;
		} catch {
			return undefined;
		}
	}

	async setAuth(key: string, auth: { token: string; exp: number } | undefined): Promise<void> {
		if (auth) {
			await this.context.secrets.store(`lightchain.auth.${key}`, JSON.stringify(auth));
		} else {
			await this.context.secrets.delete(`lightchain.auth.${key}`);
		}
	}

	exportKey(id: string): Thenable<string | undefined> {
		return this.context.secrets.get(secretKey(id));
	}

	// ---- browser wallets ----------------------------------------------------------

	/** Open the connect page in the user's browser; resolves when a wallet is connected. */
	async connectBrowser(): Promise<WalletAccount> {
		const info = await this.bridge.connect();
		await this.context.globalState.update(BROWSER_KEY, { address: info.address, wallet: info.wallet });
		await this.context.globalState.update(ACTIVE_KEY, BROWSER_ID);
		this._onDidChange.fire();
		return this.browserAccount!;
	}

	/** Bring the browser connect/sign page to the front (it hosts pending wallet requests). */
	async openBridgePage(): Promise<boolean> {
		await this.bridge.ensureOrigin();
		return vscode.env.openExternal(vscode.Uri.parse(`${this.bridge.pageUrl}?mode=sign`));
	}

	// ---- chain access ------------------------------------------------------------

	publicClient(network: LightchainNetwork) {
		return createPublicClient({ chain: toViemChain(network), transport: http(network.rpcUrl, { timeout: 10_000 }) });
	}

	async balance(account: WalletAccount, network: LightchainNetwork): Promise<string> {
		return formatEther(await this.publicClient(network).getBalance({ address: account.address }));
	}

	/** EIP-191 personal_sign. `purpose` is shown on the browser wallet page. */
	async signMessage(account: WalletAccount, network: LightchainNetwork, message: string, purpose?: string): Promise<Hex> {
		if (account.kind === 'browser') {
			return this.bridge.request<Hex>(network, 'personal_sign', [toHex(message), account.address], account.address, purpose);
		}
		const key = await this.exportKey(account.id);
		if (!key) {
			throw new Error(`The key for "${account.name}" is missing from the keychain.`);
		}
		return privateKeyToAccount(key as Hex).signMessage({ message });
	}

	/**
	 * Send a transaction exactly as a tool built it (forge: nonce, gas, fees) and
	 * return the hash without waiting — the caller tracks the receipt. `to`
	 * undefined = contract creation.
	 */
	async sendRawFromTx(account: WalletAccount, network: LightchainNetwork, tx: {
		to?: `0x${string}`; data?: Hex; value?: bigint; gas?: bigint; nonce?: number;
		gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint;
	}, purpose?: string): Promise<Hex> {
		await this.confirmMainnet(account, network, tx, purpose ?? (tx.to ? 'Transaction from a Foundry script' : 'Contract deployment from a Foundry script'));
		if (account.kind === 'browser') {
			return this.bridge.request<Hex>(network, 'eth_sendTransaction', [{
				from: account.address,
				to: tx.to,
				data: tx.data,
				value: tx.value !== undefined ? toHex(tx.value) : undefined,
				gas: tx.gas !== undefined ? toHex(tx.gas) : undefined,
				gasPrice: tx.gasPrice !== undefined ? toHex(tx.gasPrice) : undefined,
				maxFeePerGas: tx.maxFeePerGas !== undefined ? toHex(tx.maxFeePerGas) : undefined,
				maxPriorityFeePerGas: tx.maxPriorityFeePerGas !== undefined ? toHex(tx.maxPriorityFeePerGas) : undefined,
			}], account.address, purpose);
		}
		const key = await this.exportKey(account.id);
		if (!key) {
			throw new Error(`The key for "${account.name}" is missing from the keychain.`);
		}
		const client = createWalletClient({ account: privateKeyToAccount(key as Hex), chain: toViemChain(network), transport: http(network.rpcUrl) });
		const fees = tx.maxFeePerGas !== undefined
			? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
			: tx.gasPrice !== undefined ? { gasPrice: tx.gasPrice } : {};
		return client.sendTransaction({ to: tx.to ?? null, data: tx.data, value: tx.value, gas: tx.gas, nonce: tx.nonce, ...fees } as Parameters<typeof client.sendTransaction>[0]);
	}

	/**
	 * What a transaction would do, as a few plain lines (set by the extension: it runs the
	 * transaction on a private copy of the network). Undefined when it cannot be told.
	 */
	preview?: (account: WalletAccount, network: LightchainNetwork, tx: { to?: `0x${string}`; data?: Hex; value?: bigint }, purpose?: string) => Promise<string[] | undefined>;

	/**
	 * Mainnet guard: real LCAI is at stake, so every mainnet transaction gets an explicit
	 * confirmation with what it does, what it would change, the value and the estimated fee.
	 * With "lightchain.simulate.before": "always" testnet transactions are previewed the same way.
	 * Throws if declined.
	 */
	async confirmMainnet(account: WalletAccount, network: LightchainNetwork, tx: { to?: `0x${string}`; data?: Hex; value?: bigint; gas?: bigint }, purpose?: string): Promise<void> {
		const mode = vscode.workspace.getConfiguration('lightchain.simulate').get<string>('before', 'mainnet');
		const mainnet = network.id === 'mainnet';
		if (!mainnet && mode !== 'always') {
			return;
		}
		const effects = mode === 'never' ? undefined : await this.preview?.(account, network, tx, purpose).catch(() => undefined);
		let fee = 'unknown';
		try {
			const client = this.publicClient(network);
			const [gas, price] = await Promise.all([
				tx.gas ?? client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value }),
				client.getGasPrice(),
			]);
			fee = `≈ ${Number(formatEther(gas * price)).toPrecision(3)} LCAI`;
		} catch { /* the wallet will show it */ }
		const lines = [
			purpose ?? (tx.to ? `Transaction to ${tx.to}` : 'Contract deployment'),
			`From: ${account.name} (${account.address})`,
			...(tx.value ? [`Value: ${formatEther(tx.value)} LCAI`] : []),
			`Network fee: ${fee}`,
			...(effects?.length ? ['', 'What will happen:', ...effects.map(l => `• ${l}`)] : []),
		];
		const wouldFail = !!effects?.[0]?.includes('would FAIL');
		const send = wouldFail ? 'Send Anyway' : mainnet ? 'Send on Mainnet' : 'Send';
		const title = wouldFail ? 'This transaction would fail' : `Send this transaction on Lightchain ${network.label}?`;
		const ok = await vscode.window.showWarningMessage(title, { modal: true, detail: `${lines.join('\n')}${mainnet ? '\n\nThis uses real LCAI and cannot be undone.' : ''}` }, send);
		if (ok !== send) {
			throw new Error(`Cancelled — the ${mainnet ? 'mainnet ' : ''}transaction was not sent.`);
		}
	}

	/** Send a transaction on `network` and wait for it to be mined. Returns the tx hash. */
	async sendTransaction(account: WalletAccount, network: LightchainNetwork, tx: TxRequest, purpose?: string): Promise<Hex> {
		await this.confirmMainnet(account, network, tx, purpose);
		let hash: Hex;
		if (account.kind === 'browser') {
			// The connect page switches/adds the Lightchain network before sending.
			hash = await this.bridge.request<Hex>(network, 'eth_sendTransaction', [{
				from: account.address,
				to: tx.to,
				data: tx.data,
				value: tx.value !== undefined ? toHex(tx.value) : undefined,
			}], account.address, purpose);
		} else {
			const key = await this.exportKey(account.id);
			if (!key) {
				throw new Error(`The key for "${account.name}" is missing from the keychain.`);
			}
			const client = createWalletClient({ account: privateKeyToAccount(key as Hex), chain: toViemChain(network), transport: http(network.rpcUrl) });
			hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
		}
		const receipt = await this.publicClient(network).waitForTransactionReceipt({ hash, timeout: 120_000 });
		if (receipt.status !== 'success') {
			// the debugger can say why
			void vscode.window.showErrorMessage('The transaction was sent but failed on chain.', 'Why Did It Fail?').then(pick => pick && vscode.commands.executeCommand('lightchain.tx.debug', hash));
			throw new Error(`Transaction reverted: ${hash}`);
		}
		return hash;
	}

	dispose(): void {
		this._onDidChange.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

export { isAddress };
