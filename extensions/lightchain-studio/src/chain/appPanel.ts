import * as vscode from 'vscode';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NetworkState } from '../networkState';
import { siteCss } from '../ui/site';
import { generateApp } from './appTemplate';
import { ProjectAbis } from './projectAbis';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

/**
 * App preview: makes a small web app for a deployed contract (app/<Name>/index.html
 * in the project) and shows it running in a tab. It reads the contract live;
 * changing things needs a browser wallet, so the tab offers "Open in browser".
 * The file belongs to the project: edit it, or ask Lightchain AI to reshape it.
 */
export class AppPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private server?: http.Server;
	private port = 0;
	private current?: { name: string; file: string };
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly network: NetworkState,
		private readonly abis: ProjectAbis,
		private readonly deployed: () => { name?: string; address: `0x${string}` }[],
		private readonly ask: (request: string, file?: string) => Promise<void>,
	) { }

	async open(target?: { address: `0x${string}`; name?: string }): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) {
			vscode.window.showInformationMessage('Open a project to make an app for one of its contracts.');
			return;
		}
		const index = await this.abis.index();
		const usable = this.deployed().filter(p => p.name && index.byName(p.name));
		const chosen = target?.name && index.byName(target.name) ? target : usable.length === 1 ? usable[0] : usable.length
			? (await vscode.window.showQuickPick(usable.map(p => ({ label: p.name!, description: p.address, program: p })), { title: 'Make an app for which contract?' }))?.program
			: undefined;
		if (!chosen?.name) {
			if (!usable.length) {
				const pick = await vscode.window.showInformationMessage('An app needs a deployed contract from this project. Deploy one first (testnet is free).', 'Deploy a Contract');
				if (pick) {
					await vscode.commands.executeCommand('lightchain.deployContract');
				}
			}
			return;
		}
		const rel = `app/${chosen.name}/index.html`;
		const file = vscode.Uri.joinPath(root, rel);
		const exists = await Promise.resolve(vscode.workspace.fs.stat(file)).then(() => true, () => false);
		let write = !exists;
		if (exists) {
			const pick = await vscode.window.showInformationMessage(`${rel} already exists.`, { modal: true, detail: 'Open the app as it is, or make it again from the contract (your edits to that file are replaced).' }, 'Open It', 'Make It Again');
			if (!pick) {
				return;
			}
			write = pick === 'Make It Again';
		}
		if (write) {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'app', chosen.name));
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(generateApp({ name: chosen.name, address: chosen.address, abi: index.byName(chosen.name)!.abi, network: this.network.current })));
		}
		await this.serve(path.join(root.fsPath, 'app'));
		this.current = { name: chosen.name, file: rel };
		this.show();
	}

	private get url(): string {
		return `http://127.0.0.1:${this.port}/${encodeURIComponent(this.current?.name ?? '')}/`;
	}

	/** A loopback-only static server for the project's app/ folder. */
	private serve(dir: string): Promise<void> {
		if (this.server) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const host = req.headers.host ?? '';
				if (req.method !== 'GET' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
					res.writeHead(403).end();
					return;
				}
				let rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
				if (rel.endsWith('/')) {
					rel += 'index.html';
				}
				const file = path.normalize(path.join(dir, rel));
				if (!file.startsWith(dir + path.sep)) {
					res.writeHead(403).end();
					return;
				}
				fs.readFile(file, (err, data) => {
					if (err) {
						res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
						return;
					}
					res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
				});
			});
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				this.server = server;
				this.port = (server.address() as { port: number }).port;
				resolve();
			});
		});
	}

	private show(): void {
		const cur = this.current!;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('lightchain.app', 'App preview', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
			// the app is a file: show edits as they are saved
			this.disposables.push(vscode.workspace.onDidSaveTextDocument(d => { if (this.panel && /(^|\/)app\//.test(vscode.workspace.asRelativePath(d.uri, false))) { void this.panel.webview.postMessage({ type: 'reload' }); } }));
		}
		this.panel.title = `${cur.name} · App`;
		this.panel.webview.html = this.html(this.panel.webview);
		this.panel.reveal(vscode.ViewColumn.Active);
	}

	private async onMessage(m: any): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		const cur = this.current;
		if (!root || !cur) {
			return;
		}
		switch (m?.type) {
			case 'browser':
				return void vscode.env.openExternal(vscode.Uri.parse(this.url));
			case 'edit':
				return void vscode.window.showTextDocument(vscode.Uri.joinPath(root, cur.file), { viewColumn: vscode.ViewColumn.Beside });
			case 'reshape': {
				const want = await vscode.window.showInputBox({ title: 'Reshape the app with Lightchain AI', prompt: 'What should it look like or do?', placeHolder: 'e.g. Make it a simple savings page: one big balance, a deposit box and a withdraw button', ignoreFocusOut: true });
				return want?.trim() ? this.ask(`Change the web app in ${cur.file} (one HTML file, no build step, it talks to the ${cur.name} contract with viem): ${want.trim()}. Keep the CONFIG block and the wallet and contract code working.`, cur.file) : undefined;
			}
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const font = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'Inter-latin.woff2'));
		const origin = `http://127.0.0.1:${this.port}`;
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	${siteCss(String(font))}
	html, body { height: 100%; }
	body { display: flex; flex-direction: column; }
	.bar { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid var(--lc-rule); }
	.bar .what { flex: 1; min-width: 160px; color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.bar .what b { display: block; color: var(--lc-text-strong); font-size: 13px; font-weight: 600; }
	iframe { flex: 1; width: 100%; border: 0; background: #070710; }
</style>
</head>
<body>
	<div class="bar">
		<div class="what"><b>${this.current!.name} app</b>Reads the contract live. To change things, open it in your browser where your wallet is.</div>
		<button class="button button-xs" id="edit">Edit the file</button>
		<button class="button button-xs" id="reshape">Reshape with Lightchain AI</button>
		<button class="button button-xs button-primary" id="browser">Open in browser</button>
	</div>
	<iframe id="app" src="${this.url}" title="App preview"></iframe>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	for (const id of ['edit', 'reshape', 'browser']) document.getElementById(id).onclick = () => vscode.postMessage({ type: id });
	window.addEventListener('message', e => { if (e.data && e.data.type === 'reload') { const f = document.getElementById('app'); f.src = f.src; } });
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.server?.close();
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
