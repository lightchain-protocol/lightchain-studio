import * as vscode from 'vscode';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { hexToBigInt, type Hex } from 'viem';
import { LightchainNetwork } from './networks';
import { Wallet, WalletAccount } from './wallet';

/**
 * Local JSON-RPC signing proxy for Foundry deploys.
 *
 * forge runs with `--rpc-url <proxy> --unlocked --sender <address>`: every
 * read is forwarded to the Lightchain RPC; `eth_sendTransaction` is signed by
 * the active Lightchain Studio wallet (local key inside the IDE, or the user's
 * browser wallet via BrowserBridge). Private keys never reach forge's argv,
 * environment or terminal.
 *
 * Loopback-only, random token in the path, one proxy per deploy.
 */
export class SigningProxy implements vscode.Disposable {
	private server?: http.Server;
	private readonly token = randomBytes(24).toString('hex');
	url = '';
	sent = 0;

	constructor(private readonly wallet: Wallet, private readonly account: WalletAccount, private readonly network: LightchainNetwork) { }

	async start(): Promise<string> {
		const server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
		this.server = server;
		this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${this.token}`;
		return this.url;
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== 'POST' || req.url !== `/${this.token}` || req.headers.origin !== undefined) {
			res.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', async () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				const out = Array.isArray(body) ? await Promise.all(body.map(r => this.dispatch(r))) : await this.dispatch(body);
				res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
			} catch (err) {
				res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: (err as Error).message } }));
			}
		});
	}

	private async dispatch(call: { id: unknown; method: string; params?: any[] }): Promise<unknown> {
		const reply = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
		const fail = (message: string, code = -32000) => ({ jsonrpc: '2.0', id: call.id, error: { code, message } });
		try {
			switch (call.method) {
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return reply([this.account.address]);
				case 'eth_sendTransaction': {
					const tx = call.params?.[0] ?? {};
					if (tx.from && tx.from.toLowerCase() !== this.account.address.toLowerCase()) {
						return fail(`Sender ${tx.from} is not the active Lightchain Studio account ${this.account.address}.`);
					}
					const hash = await this.wallet.sendRawFromTx(this.account, this.network, {
						to: tx.to ?? undefined,
						data: tx.input ?? tx.data,
						value: tx.value ? hexToBigInt(tx.value) : undefined,
						gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
						nonce: tx.nonce !== undefined ? Number(hexToBigInt(tx.nonce)) : undefined,
						gasPrice: tx.gasPrice ? hexToBigInt(tx.gasPrice) : undefined,
						maxFeePerGas: tx.maxFeePerGas ? hexToBigInt(tx.maxFeePerGas) : undefined,
						maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? hexToBigInt(tx.maxPriorityFeePerGas) : undefined,
					});
					this.sent++;
					return reply(hash);
				}
				case 'eth_sign':
				case 'personal_sign':
				case 'eth_signTypedData_v4':
					return fail(`${call.method} is not supported for deploys.`, -32601);
				default: {
					// Forward reads (and eth_sendRawTransaction) to the Lightchain RPC.
					const upstream = await fetch(this.network.rpcUrl, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params ?? [] }),
						signal: AbortSignal.timeout(60_000),
					});
					return await upstream.json();
				}
			}
		} catch (err) {
			return fail((err as Error).message);
		}
	}

	dispose(): void {
		this.server?.close();
	}
}

export type { Hex };
