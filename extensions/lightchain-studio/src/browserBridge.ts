import * as vscode from 'vscode';
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import { LightchainNetwork, NETWORKS } from './networks';
import { connectPageHtml } from './connectPage';

/**
 * Browser wallet bridge — connects any browser wallet extension (MetaMask,
 * Rabby, Coinbase, Brave, Phantom, hardware wallets through them) without a
 * WalletConnect project ID. Same approach as Foundry's `--browser` mode.
 *
 * The IDE serves a one-time connect page on 127.0.0.1. The page discovers
 * wallets (EIP-6963), and relays signing requests: IDE → page via
 * Server-Sent Events, page → IDE via POST. Nothing leaves the machine.
 *
 * Security: loopback-only bind, 256-bit token in every path, Host/Origin must
 * be exactly our loopback origin (blocks DNS rebinding and other sites).
 */
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface ConnectedInfo { address: `0x${string}`; chainId: number; wallet: string }

const REQUEST_TIMEOUT_MS = 5 * 60_000;
// The page origin must stay the same across IDE restarts: wallets remember site
// permissions per origin, and the page remembers the chosen wallet in localStorage.
const PORT_KEY = 'lightchain.bridge.port';
/**
 * Lightchain AI sign-in (SIWE) only accepts the domain "localhost:3000", and
 * wallets warn when the SIWE domain differs from the requesting page. Serving
 * the page from that exact origin avoids the warning. Used only when nothing
 * else is listening there; otherwise we fall back to our saved port.
 */
export const SIWE_ORIGIN = 'http://localhost:3000';
const TOKEN_SECRET = 'lightchain.bridge.token';
const PAGE_WAIT_MS = 90_000;

export class BrowserBridge implements vscode.Disposable {
	private server?: http.Server;
	private origin = '';
	private token = '';
	private clients = new Set<http.ServerResponse>();
	private pending = new Map<string, Pending>();
	private seq = 0;
	private waitingForPage: Array<() => void> = [];
	private connectWaiter?: { resolve: (i: ConnectedInfo) => void; reject: (e: Error) => void };
	private heartbeat?: ReturnType<typeof setInterval>;

	private readonly _onDidChangeAccount = new vscode.EventEmitter<ConnectedInfo | undefined>();
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	constructor(private readonly context: vscode.ExtensionContext) { }

	get pageUrl(): string {
		return `${this.origin}/connect/${this.token}`;
	}

	/** Open the connect page and resolve once the user connects a wallet. */
	async connect(): Promise<ConnectedInfo> {
		await this.ensureServer();
		this.connectWaiter?.reject(new Error('Superseded by a new connection attempt.'));
		const result = new Promise<ConnectedInfo>((resolve, reject) => { this.connectWaiter = { resolve, reject }; });
		await vscode.env.openExternal(vscode.Uri.parse(`${this.pageUrl}?mode=connect`));
		return result;
	}

	/** The loopback origin the page is served from (starts the server). */
	async ensureOrigin(): Promise<string> {
		await this.ensureServer();
		return this.origin;
	}

	/** True while a connect page tab is open and listening. */
	get pageOpen(): boolean {
		return this.clients.size > 0;
	}

	/**
	 * EIP-1193 request executed by the user's browser wallet on `network`.
	 * `purpose` is shown on the page so the user knows what they are approving.
	 */
	async request<T>(network: LightchainNetwork, method: string, params: unknown[], expectedAddress?: string, purpose?: string): Promise<T> {
		await this.ensureServer();
		if (this.clients.size === 0) {
			await vscode.env.openExternal(vscode.Uri.parse(`${this.pageUrl}?mode=sign`));
			await this.waitForPage();
		}
		const id = `${Date.now().toString(36)}-${++this.seq}`;
		const result = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('The wallet did not respond. Check the Lightchain Studio tab in your browser.'));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
		});
		this.broadcast({ type: 'request', id, method, params, expectedAddress, purpose, chain: chainParams(network) });
		return result;
	}

	// ---- server ----------------------------------------------------------------------

	private async ensureServer(): Promise<void> {
		if (this.server) {
			return;
		}
		this.token = await this.context.secrets.get(TOKEN_SECRET) ?? '';
		if (!/^[0-9a-f]{64}$/.test(this.token)) {
			this.token = randomBytes(32).toString('hex');
			await this.context.secrets.store(TOKEN_SECRET, this.token);
		}
		const server = http.createServer((req, res) => this.handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500).end(); } }));
		const listen = (p: number) => new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
		});
		let host = '127.0.0.1';
		if (!(await portInUse(3000))) {
			try {
				await listen(3000);
				host = 'localhost';
			} catch { /* taken meanwhile */ }
		}
		if (host !== 'localhost') {
			const saved = this.context.globalState.get<number>(PORT_KEY);
			try {
				await listen(saved ?? 0);
			} catch {
				await listen(0); // saved port taken by something else
			}
			await this.context.globalState.update(PORT_KEY, (server.address() as AddressInfo).port);
		}
		const { port } = server.address() as AddressInfo;
		this.origin = `http://${host}:${port}`;
		this.server = server;
		this.heartbeat = setInterval(() => this.clients.forEach(c => c.write(': ping\n\n')), 15_000);
	}

	private tokenOk(candidate: string): boolean {
		const a = Buffer.from(candidate);
		const b = Buffer.from(this.token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		// Only our exact loopback origin may talk to us (DNS-rebinding / cross-site protection).
		const host = req.headers.host ?? '';
		if (`http://${host}` !== this.origin) {
			res.writeHead(421).end();
			return;
		}
		const origin = req.headers.origin;
		if (origin !== undefined && origin !== this.origin) {
			res.writeHead(403).end();
			return;
		}
		const url = new URL(req.url ?? '/', this.origin);
		const parts = url.pathname.split('/').filter(Boolean); // connect/<token>/<action?>
		if (parts[0] === 'assets' && req.method === 'GET') {
			return this.serveAsset(parts.slice(1).join('/'), res);
		}
		if (parts[0] !== 'connect' || !parts[1] || !this.tokenOk(parts[1])) {
			res.writeHead(404).end();
			return;
		}
		const action = parts[2];
		if (!action && req.method === 'GET') {
			const nonce = randomBytes(16).toString('base64');
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			});
			res.end(connectPageHtml({ nonce, networks: Object.values(NETWORKS).map(chainParams), known: this.context.globalState.get<{ address: string; wallet: string }>('lightchain.wallet.browser') }));
			return;
		}
		if (action === 'events' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
			res.write(': connected\n\n');
			this.clients.add(res);
			this.waitingForPage.splice(0).forEach(fn => fn());
			req.on('close', () => this.clients.delete(res));
			return;
		}
		if (action === 'message' && req.method === 'POST') {
			if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
				res.writeHead(415).end();
				return;
			}
			const body = await readJson(req);
			this.onPageMessage(body);
			res.writeHead(204).end();
			return;
		}
		res.writeHead(404).end();
	}

	private async serveAsset(name: string, res: http.ServerResponse): Promise<void> {
		const allowed: Record<string, string> = {
			'site-components.css': 'text/css; charset=utf-8',
			'Inter-latin.woff2': 'font/woff2',
			'Inter-latin-ext.woff2': 'font/woff2',
			'logo.svg': 'image/svg+xml',
			'fa-wallet.svg': 'image/svg+xml',
		};
		const type = allowed[name];
		if (!type) {
			res.writeHead(404).end();
			return;
		}
		const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
		res.end(Buffer.from(data));
	}

	private onPageMessage(msg: any): void {
		switch (msg?.type) {
			case 'connected': {
				if (typeof msg.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(msg.address)) {
					return;
				}
				const info: ConnectedInfo = { address: msg.address, chainId: Number(msg.chainId), wallet: String(msg.wallet ?? 'Browser wallet').slice(0, 64) };
				this.connectWaiter?.resolve(info);
				this.connectWaiter = undefined;
				this._onDidChangeAccount.fire(info);
				return;
			}
			case 'accountsChanged': {
				const address = typeof msg.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(msg.address) ? msg.address : undefined;
				this._onDidChangeAccount.fire(address ? { address, chainId: Number(msg.chainId), wallet: String(msg.wallet ?? 'Browser wallet').slice(0, 64) } : undefined);
				return;
			}
			case 'connectFailed':
				this.connectWaiter?.reject(new Error(String(msg.message ?? 'Wallet connection was rejected.')));
				this.connectWaiter = undefined;
				return;
			case 'result':
			case 'error': {
				const p = this.pending.get(String(msg.id));
				if (!p) {
					return;
				}
				this.pending.delete(String(msg.id));
				clearTimeout(p.timer);
				if (msg.type === 'result') {
					p.resolve(msg.result);
				} else {
					p.reject(new Error(String(msg.error?.message ?? 'Request rejected in the wallet.')));
				}
				return;
			}
		}
	}

	private broadcast(event: unknown): void {
		const line = `data: ${JSON.stringify(event)}\n\n`;
		this.clients.forEach(c => c.write(line));
	}

	private waitForPage(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('The Lightchain Studio wallet page did not open in your browser.')), PAGE_WAIT_MS);
			this.waitingForPage.push(() => { clearTimeout(timer); resolve(); });
		});
	}

	dispose(): void {
		clearInterval(this.heartbeat);
		this.pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('Lightchain Studio closed.')); });
		this.clients.forEach(c => c.end());
		this.server?.close();
		this._onDidChangeAccount.dispose();
	}
}

/** Is anything (a dev server, typically) already answering on localhost:port? */
function portInUse(port: number): Promise<boolean> {
	const probe = (host: string) => new Promise<boolean>(resolve => {
		const socket = net.connect({ host, port });
		socket.setTimeout(400);
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('timeout', () => { socket.destroy(); resolve(false); });
		socket.once('error', () => resolve(false));
	});
	return Promise.all([probe('127.0.0.1'), probe('::1')]).then(r => r.some(Boolean));
}

/** wallet_addEthereumChain parameters for a Lightchain network. */
export function chainParams(n: LightchainNetwork) {
	return {
		chainId: `0x${n.chainId.toString(16)}`,
		chainName: `Lightchain ${n.label}`,
		nativeCurrency: { name: 'LightchainAI', symbol: 'LCAI', decimals: 18 },
		rpcUrls: [n.rpcUrl],
		blockExplorerUrls: [n.explorerUrl],
	};
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > 256 * 1024) {
				reject(new Error('payload too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
		});
		req.on('error', reject);
	});
}
