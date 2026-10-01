import * as vscode from 'vscode';
import { AbiFunction, AbiParameter, decodeFunctionResult, encodeFunctionData, formatEther, isAddress, isHex, parseEther, type Abi } from 'viem';
import { NetworkState } from './networkState';
import { LightchainNetwork, addressUrl, txUrl } from './networks';
import { Wallet } from './wallet';
import { Program } from './deployedPrograms';
import { friendlyError } from './aiView';

/**
 * Contract interaction tab for a deployed program: read (view/pure) and write
 * functions from the contract ABI.
 *
 * ABI source, first match wins: the project's Foundry artifacts (by contract
 * name, else by matching the on-chain runtime bytecode), then Lightscan
 * (verified contracts), then an ABI file the user picks.
 *
 * Writes are simulated first (revert reasons show before anything is signed),
 * local keys confirm in a modal, browser wallets confirm in the wallet.
 */
const VIEW_TYPE = 'lightchain.interact';

interface ResolvedAbi { abi: Abi; name?: string; source: string }

export class InteractPanels implements vscode.Disposable {
	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly wallet: Wallet,
		private readonly network: NetworkState,
		private readonly onIdentified: (address: string, name: string) => void,
	) { }

	async open(program: Program): Promise<void> {
		const net = this.network.current;
		const key = `${net.id}:${program.address.toLowerCase()}`;
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal();
			return;
		}
		const resolved = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading contract ABI…' },
			() => resolveAbi(program, net, this.wallet));
		if (!resolved) {
			const pick = await vscode.window.showWarningMessage(
				`No ABI found for ${program.name ?? program.address}. Build the project with Foundry, verify it on Lightscan, or choose an ABI file.`,
				'Choose ABI file…');
			if (pick) {
				const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'ABI / Foundry artifact': ['json'] } });
				const abi = files?.[0] ? readAbiJson(new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0]))) : undefined;
				if (abi) {
					return this.show(key, program, net, { abi, source: vscode.workspace.asRelativePath(files![0]) });
				}
				vscode.window.showErrorMessage('That file has no ABI (expected a JSON array or a Foundry artifact with "abi").');
			}
			return;
		}
		this.show(key, program, net, resolved);
	}

	private show(key: string, program: Program, net: LightchainNetwork, resolved: ResolvedAbi): void {
		const name = program.name ?? resolved.name ?? 'Contract';
		if (!program.name && resolved.name) {
			this.onIdentified(program.address, resolved.name);
		}
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `${name} · ${net.label}`, vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: true,
		});
		panel.iconPath = vscode.Uri.joinPath(media, 'lightchain.svg');
		this.panels.set(key, panel);
		panel.onDidDispose(() => this.panels.delete(key), undefined, this.disposables);

		const fns = (resolved.abi.filter(x => x.type === 'function') as AbiFunction[]);
		const describe = (f: AbiFunction, i: number) => ({
			id: i,
			name: f.name,
			read: f.stateMutability === 'view' || f.stateMutability === 'pure',
			payable: f.stateMutability === 'payable',
			inputs: f.inputs.map(p => ({ name: p.name || '', type: typeLabel(p) })),
			outputs: f.outputs.map(p => typeLabel(p)).join(', '),
		});
		panel.webview.html = this.html(panel.webview, {
			name, address: program.address, network: net.label, explorer: addressUrl(net, program.address), source: resolved.source,
			functions: fns.map(describe),
		});

		panel.webview.onDidReceiveMessage(async msg => {
			if (msg?.type === 'external' && typeof msg.url === 'string' && /^https:\/\//.test(msg.url)) {
				return vscode.env.openExternal(vscode.Uri.parse(msg.url));
			}
			if (msg?.type !== 'run') {
				return;
			}
			const fn = fns[Number(msg.id)];
			if (!fn) {
				return;
			}
			const reply = (state: string, kind: 'ok' | 'err' | 'wait', text = '', link?: string) =>
				panel.webview.postMessage({ type: 'result', id: msg.id, state, kind, text, link });
			let args: unknown[];
			let value: bigint | undefined;
			try {
				args = fn.inputs.map((p, i) => parseArg(p, String(msg.args?.[i] ?? '')));
				value = fn.stateMutability === 'payable' && String(msg.value ?? '').trim() ? parseEther(String(msg.value).trim()) : undefined;
			} catch (err) {
				return reply('Invalid input', 'err', (err as Error).message);
			}
			const client = this.wallet.publicClient(net);
			const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
			const account = this.wallet.active;

			if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
				try {
					reply('Calling', 'wait');
					const { data: raw } = await client.call({ to: program.address, data, account: account?.address });
					const out = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw ?? '0x' });
					reply('Result', 'ok', formatOutputs(fn, out));
				} catch (err) {
					reply('Failed', 'err', friendlyError(err));
				}
				return;
			}

			if (!account) {
				return reply('No wallet', 'err', 'Connect a wallet (status bar) to send transactions.');
			}
			try {
				reply('Simulating', 'wait');
				await client.call({ to: program.address, data, value, account: account.address });
			} catch (err) {
				return reply('Would revert', 'err', friendlyError(err, account));
			}
			const call = `${fn.name}(${args.map(a => formatValue(a)).join(', ')})`;
			if (account.kind === 'local') {
				const ok = await vscode.window.showWarningMessage(
					`Send ${call} to ${name} on ${net.label}?`,
					{ modal: true, detail: `From ${account.name} (${account.address})${value ? `\nValue: ${formatEther(value)} LCAI` : ''}\nThis is an on-chain transaction and costs gas.` },
					'Send');
				if (ok !== 'Send') {
					return reply('Cancelled', 'err');
				}
			}
			try {
				reply(account.kind === 'browser' ? 'Approve in your wallet' : 'Sending', 'wait');
				const hash = await this.wallet.sendTransaction(account, net, { to: program.address, data, value }, `Call ${call} on ${name}`);
				reply('Confirmed', 'ok', hash, txUrl(net, hash));
				panel.webview.postMessage({ type: 'refreshReads' });
			} catch (err) {
				reply('Failed', 'err', friendlyError(err, account));
			}
		}, undefined, this.disposables);
	}

	private html(webview: vscode.Webview, data: unknown): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const media = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', p));
		const json = JSON.stringify(data).replace(/</g, '\\u003c');
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin-ext.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
	/* site body (default/_typography.scss): Inter 16px, #7376aa on #070710 */
	html, body { margin: 0; background: #070710; }
	body { font-family: "Inter", sans-serif; font-size: 16px; line-height: 1.6; color: #7376aa; -webkit-font-smoothing: antialiased; }
	*, *::before, *::after { box-sizing: border-box; }
	h4, p { margin: 0; }
	/* site base 16px -> IDE 13px (13/16), as in the Lightchain AI panel */
	.lc-page { zoom: 0.8125; max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }
	/* .lc-sm-title.border-left eyebrow */
	.lc-sm-title { margin: 0; padding-left: 10px; border-left: 3px solid #dd00ac; color: #b1b3d0; font-size: 16px; font-weight: 500; line-height: 19.2px; letter-spacing: -0.096px; text-transform: uppercase; }
	.lc-block + .lc-block { margin-top: 40px; }
	.lc-text { margin-top: 12px; color: #b1b3d0; font-size: 14px; line-height: 1.5; }
	/* .live-network-metrics__card */
	.lc-card { padding: 22px; background: #020203; border: 1px solid rgba(204, 206, 239, 0.16); }
	.lc-card__value { color: #f5f6ff; font-size: 20px; font-weight: 500; line-height: 1.2; word-break: break-all; }
	.lc-card__label { margin-top: 8px; color: #b1b3d0; font-size: 14px; line-height: 1.2; }
	.lc-head { margin-top: 16px; display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; }
	.lc-grid { margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
	.lc-fn { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; background: #020203; border: 1px solid rgba(204, 206, 239, 0.16); }
	.lc-fn__head { display: flex; justify-content: space-between; gap: 8px; color: #b1b3d0; font-size: 14px; }
	.lc-fn__name { color: #f5f6ff; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-fn__sig { color: #7376aa; font-size: 13px; font-family: Menlo, Monaco, "Courier New", monospace; word-break: break-all; }
	.lc-fn__state.ok { color: #3eb75e; } .lc-fn__state.err { color: #ff2a27; } .lc-fn__state.wait { color: #ff8f3c; }
	.lc-fn__out { color: #ccceef; font-size: 13px; font-family: Menlo, Monaco, "Courier New", monospace; white-space: pre-wrap; word-break: break-all; }
	.lc-fn__out a { color: #ccceef; }
	/* default/_forms.scss input */
	input { display: block; width: 100%; height: 40px; padding: 0 15px; background: transparent; border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 10px; outline: none; color: #ccceef; font-family: "Inter", sans-serif; font-size: 14px; }
	input:focus { border-color: rgba(255, 255, 255, 0.2); }
	input::placeholder { color: #7376aa; }
	/* .btn-default (gradient) / .btn-border-white-blur (ghost) at .btn-small */
	.btn-default { display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 16px; border: 0; border-radius: 8px; background: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); color: #fff; font-family: "Inter", sans-serif; font-size: 14px; font-weight: 400; letter-spacing: 0.5px; text-transform: uppercase; cursor: pointer; white-space: nowrap; align-self: flex-start; }
	.btn-default.ghost { background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.2); color: #ccceef; backdrop-filter: blur(6px); }
	.btn-default:disabled { opacity: .5; cursor: default; }
	[hidden] { display: none !important; }
</style>
</head>
<body>
<main class="lc-page">
	<section class="lc-block">
		<h4 class="lc-sm-title" id="title"></h4>
		<div class="lc-head">
			<div class="lc-card"><div class="lc-card__value" id="address"></div><div class="lc-card__label" id="meta"></div></div>
			<button class="btn-default ghost" id="explorer">Open on Lightscan</button>
		</div>
	</section>
	<section class="lc-block" id="readBlock">
		<h4 class="lc-sm-title">Read &gt;&gt;</h4>
		<p class="lc-text">Free calls — nothing is signed or sent.</p>
		<div class="lc-grid" id="reads"></div>
	</section>
	<section class="lc-block" id="writeBlock">
		<h4 class="lc-sm-title">Write &gt;&gt;</h4>
		<p class="lc-text">On-chain transactions from your active wallet. Each one is simulated first, then you confirm it.</p>
		<div class="lc-grid" id="writes"></div>
	</section>
</main>
<script nonce="${nonce}">
(() => {
	const vscode = acquireVsCodeApi();
	const D = ${json};
	const $ = id => document.getElementById(id);
	$('title').textContent = D.name + ' >>';
	$('address').textContent = D.address;
	$('meta').textContent = 'Lightchain ' + D.network + ' · ABI from ' + D.source;
	$('explorer').onclick = () => vscode.postMessage({ type: 'external', url: D.explorer });
	const cards = new Map();
	function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
	function card(f) {
		const c = el('div', 'lc-fn');
		const head = el('div', 'lc-fn__head');
		head.append(el('span', 'lc-fn__name', f.name), el('span', 'lc-fn__state'));
		c.append(head, el('div', 'lc-fn__sig', f.name + '(' + f.inputs.map(i => i.type + (i.name ? ' ' + i.name : '')).join(', ') + ')' + (f.outputs ? ' → ' + f.outputs : '')));
		const inputs = f.inputs.map(i => { const x = el('input'); x.placeholder = (i.name || 'arg') + ' (' + i.type + ')'; x.spellcheck = false; c.append(x); return x; });
		let value = null;
		if (f.payable) { value = el('input'); value.placeholder = 'value in LCAI (optional)'; c.append(value); }
		const btn = el('button', 'btn-default' + (f.read ? ' ghost' : ''), f.read ? 'Call' : 'Send');
		const out = el('div', 'lc-fn__out'); out.hidden = true;
		btn.onclick = () => run();
		c.append(btn, out);
		const run = () => { btn.disabled = true; vscode.postMessage({ type: 'run', id: f.id, args: inputs.map(x => x.value), value: value ? value.value : '' }); };
		inputs.concat(value ? [value] : []).forEach(x => x.addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));
		cards.set(f.id, { c, btn, out, state: head.lastChild, run, auto: f.read && !f.inputs.length });
		return c;
	}
	const reads = D.functions.filter(f => f.read), writes = D.functions.filter(f => !f.read);
	reads.forEach(f => $('reads').append(card(f)));
	writes.forEach(f => $('writes').append(card(f)));
	$('readBlock').hidden = !reads.length; $('writeBlock').hidden = !writes.length;
	const refresh = () => cards.forEach(x => { if (x.auto) x.run(); });
	refresh(); // argument-less reads show their current value right away
	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'refreshReads') return refresh();
		if (m.type !== 'result') return;
		const x = cards.get(m.id); if (!x) return;
		x.state.textContent = m.state; x.state.className = 'lc-fn__state ' + m.kind;
		x.btn.disabled = m.kind === 'wait';
		x.out.hidden = !m.text;
		x.out.replaceChildren();
		if (m.link) { const a = el('a', '', m.text); a.href = '#'; a.onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'external', url: m.link }); }; x.out.append(a); }
		else x.out.textContent = m.text;
	});
})();
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panels.forEach(p => p.dispose());
		this.disposables.forEach(d => d.dispose());
	}
}

// ---- ABI resolution ------------------------------------------------------------------

async function resolveAbi(program: Program, net: LightchainNetwork, wallet: Wallet): Promise<ResolvedAbi | undefined> {
	const artifacts = await vscode.workspace.findFiles('**/out/**/*.json', '{**/node_modules/**,**/build-info/**,**/lib/**}', 2000);
	const decoder = new TextDecoder();
	const read = async (uri: vscode.Uri) => { try { return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri))); } catch { return undefined; } };

	// 1. Foundry artifact named like the contract: out/<File>.sol/<Name>.json
	if (program.name) {
		for (const uri of artifacts.filter(u => u.path.endsWith(`/${program.name}.json`))) {
			const a = await read(uri);
			if (Array.isArray(a?.abi)) {
				return { abi: a.abi, name: program.name, source: vscode.workspace.asRelativePath(uri) };
			}
		}
	}
	// 2. Foundry artifact whose runtime bytecode matches what is deployed
	try {
		const code = await wallet.publicClient(net).getCode({ address: program.address });
		if (code && code !== '0x') {
			const onChain = stripMetadata(code);
			for (const uri of artifacts) {
				const a = await read(uri);
				const runtime: string | undefined = a?.deployedBytecode?.object;
				if (Array.isArray(a?.abi) && runtime && runtime.length > 4 && stripMetadata(runtime) === onChain) {
					return { abi: a.abi, name: uri.path.split('/').pop()!.replace(/\.json$/, ''), source: vscode.workspace.asRelativePath(uri) };
				}
			}
		}
	} catch { /* RPC unreachable: try Lightscan */ }
	// 3. Lightscan (Blockscout) verified source
	try {
		const r = await fetch(`${net.explorerUrl}/api/v2/smart-contracts/${program.address}`, { signal: AbortSignal.timeout(10_000) });
		if (r.ok) {
			const j = await r.json() as { abi?: Abi; name?: string };
			if (Array.isArray(j.abi) && j.abi.length) {
				return { abi: j.abi, name: j.name, source: 'Lightscan (verified)' };
			}
		}
	} catch { /* offline */ }
	return undefined;
}

/** Solidity appends CBOR metadata (length in the last 2 bytes) that differs between builds. */
function stripMetadata(hex: string): string {
	const h = hex.toLowerCase().replace(/^0x/, '');
	if (h.length < 4) {
		return h;
	}
	const len = parseInt(h.slice(-4), 16) * 2 + 4;
	return len < h.length ? h.slice(0, h.length - len) : h;
}

function readAbiJson(text: string): Abi | undefined {
	try {
		const j = JSON.parse(text);
		const abi = Array.isArray(j) ? j : j?.abi;
		return Array.isArray(abi) ? abi as Abi : undefined;
	} catch {
		return undefined;
	}
}

// ---- arguments and results ---------------------------------------------------------------

function typeLabel(p: AbiParameter): string {
	if (p.type.startsWith('tuple') && 'components' in p && p.components) {
		return `(${p.components.map(typeLabel).join(', ')})${p.type.slice(5)}`;
	}
	return p.type;
}

/** Text input → ABI value. Arrays and tuples are JSON; integers accept decimal or 0x hex. */
export function parseArg(p: AbiParameter, raw: string): unknown {
	const label = p.name || p.type;
	const text = raw.trim();
	const arr = /^(.*)\[(\d*)\]$/.exec(p.type);
	if (arr || p.type === 'tuple') {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`${label}: enter JSON, e.g. ${arr ? '[1, 2]' : '["0x…", 1]'}`);
		}
		return convert(p, json, label);
	}
	return convert(p, text, label);
}

function convert(p: AbiParameter, v: unknown, label: string): unknown {
	const arr = /^(.*)\[(\d*)\]$/.exec(p.type);
	if (arr) {
		if (!Array.isArray(v)) {
			throw new Error(`${label}: expected an array`);
		}
		const inner = { ...p, type: arr[1] } as AbiParameter;
		return v.map((x, i) => convert(inner, x, `${label}[${i}]`));
	}
	if (p.type === 'tuple') {
		const comps = ('components' in p && p.components) || [];
		if (Array.isArray(v)) {
			return v.map((x, i) => convert(comps[i], x, `${label}.${comps[i]?.name || i}`));
		}
		if (v && typeof v === 'object') {
			return Object.fromEntries(comps.map(c => [c.name, convert(c, (v as Record<string, unknown>)[c.name!], `${label}.${c.name}`)]));
		}
		throw new Error(`${label}: expected a JSON array or object`);
	}
	const s = String(v ?? '').trim();
	if (/^u?int\d*$/.test(p.type)) {
		if (!/^-?(\d+|0x[0-9a-fA-F]+)$/.test(s)) {
			throw new Error(`${label}: expected a whole number`);
		}
		return BigInt(s);
	}
	if (p.type === 'bool') {
		if (!/^(true|false|1|0)$/i.test(s)) {
			throw new Error(`${label}: expected true or false`);
		}
		return /^(true|1)$/i.test(s);
	}
	if (p.type === 'address') {
		if (!isAddress(s)) {
			throw new Error(`${label}: expected a 0x… address`);
		}
		return s;
	}
	if (p.type.startsWith('bytes')) {
		if (!isHex(s)) {
			throw new Error(`${label}: expected 0x… hex`);
		}
		return s;
	}
	return s; // string
}

/** One line per return value, labelled with its name or type when there are several. */
function formatOutputs(fn: AbiFunction, out: unknown): string {
	if (fn.outputs.length <= 1) {
		return formatValue(out);
	}
	const values = out as unknown[];
	return fn.outputs.map((o, i) => `${o.name || o.type}: ${formatValue(values[i])}`).join('\n');
}

export function formatValue(v: unknown): string {
	if (typeof v === 'bigint') {
		return v.toString();
	}
	if (typeof v === 'string') {
		return v;
	}
	return JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x, 2);
}
