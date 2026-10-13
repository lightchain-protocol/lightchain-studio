import * as vscode from 'vscode';
import { Hex, decodeFunctionResult, encodeFunctionData, formatEther } from 'viem';
import { NetworkState } from '../networkState';
import { addressUrl } from '../networks';
import { page } from '../ui/page';
import { show, stateReaders } from './abiIndex';
import { ProjectAbis } from './projectAbis';
import { hex, rpc } from './rpc';

interface Watched { address: `0x${string}`; name?: string }
interface EventRow { key: string; text: string; block: number; tx: string }

const POLL_MS = 8_000;
const LOOKBACK_BLOCKS = 5_000n;

/**
 * Live dashboard of a deployed contract: its balance, its current values and
 * what it has been announcing (events), refreshed while the tab is open. A new
 * event can raise a notification, so a contract can be watched from the corner
 * of the eye.
 */
export class DashboardPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private target?: Watched;
	private timer?: ReturnType<typeof setTimeout>;
	private last = new Map<string, string>();
	private seen = new Set<string>();
	private events: EventRow[] = [];
	private from?: bigint;
	private notify = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly network: NetworkState, private readonly abis: ProjectAbis) {
		this.disposables.push(network.onDidChange(() => { if (this.panel && this.target) { this.reset(); void this.tick(); } }));
	}

	open(target: Watched): void {
		this.target = target;
		this.reset();
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('lightchain.dashboard', 'Dashboard', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.webview.html = page(this.panel.webview, this.extensionUri, { title: 'Dashboard', lead: '', css: DASHBOARD_CSS, script: DASHBOARD_SCRIPT });
			this.panel.onDidDispose(() => { this.panel = undefined; clearTimeout(this.timer); }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		}
		this.panel.title = `${target.name ?? 'Contract'} · Dashboard`;
		this.panel.reveal(vscode.ViewColumn.Active);
		void this.tick();
	}

	private reset(): void {
		clearTimeout(this.timer);
		this.last = new Map();
		this.seen = new Set();
		this.events = [];
		this.from = undefined;
	}

	private async onMessage(m: any): Promise<void> {
		switch (m?.type) {
			case 'ready':
			case 'refresh':
				return this.tick();
			case 'notify':
				this.notify = !!m.on;
				return;
			case 'interact':
				return this.target ? void vscode.commands.executeCommand('lightchain.programs.interactAddress', this.target.address, this.target.name) : undefined;
			case 'explorer':
				return this.target ? void vscode.env.openExternal(vscode.Uri.parse(addressUrl(this.network.current, this.target.address))) : undefined;
			case 'tx':
				return void vscode.commands.executeCommand('lightchain.tx.debug', String(m.hash));
		}
	}

	private async tick(): Promise<void> {
		clearTimeout(this.timer);
		const target = this.target;
		const panel = this.panel;
		if (!target || !panel) {
			return;
		}
		const net = this.network.current;
		const first = this.from === undefined;
		try {
			const index = await this.abis.index();
			const abi = target.name ? index.byName(target.name)?.abi : undefined;
			const [balance, latestHex, code] = await Promise.all([
				rpc<string>(net.rpcUrl, 'eth_getBalance', [target.address, 'latest']),
				rpc<string>(net.rpcUrl, 'eth_blockNumber'),
				first ? rpc<string>(net.rpcUrl, 'eth_getCode', [target.address, 'latest']) : Promise.resolve('0x1'),
			]);
			const latest = BigInt(latestHex);
			const values = await Promise.all((abi ? stateReaders(abi) : []).slice(0, 24).map(async fn => {
				try {
					const raw = await rpc<Hex>(net.rpcUrl, 'eth_call', [{ to: target.address, data: encodeFunctionData({ abi: [fn], functionName: fn.name }) }, 'latest'], 8_000);
					return { name: fn.name, value: show(decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw })) };
				} catch {
					return { name: fn.name, value: '—' };
				}
			}));
			const fromBlock = this.from ?? (latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n);
			const logs = fromBlock <= latest ? await rpc<{ topics: Hex[]; data: Hex; blockNumber: string; transactionHash: string; logIndex: string }[]>(net.rpcUrl, 'eth_getLogs', [{ address: target.address, fromBlock: hex(fromBlock), toBlock: hex(latest) }]).catch(() => []) : [];
			const fresh: EventRow[] = [];
			for (const l of logs) {
				const key = `${l.transactionHash}:${l.logIndex}`;
				if (!this.seen.has(key)) {
					this.seen.add(key);
					fresh.push({ key, text: index.decodeEvent(l)?.text ?? `event ${l.topics[0]?.slice(0, 10) ?? ''}`, block: Number(BigInt(l.blockNumber)), tx: l.transactionHash });
				}
			}
			this.events = [...fresh.reverse(), ...this.events].slice(0, 60);
			this.from = latest + 1n;
			if (!first && fresh.length && this.notify && !panel.visible) {
				void vscode.window.showInformationMessage(`${target.name ?? 'Your contract'}: ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`, 'Open Dashboard').then(pick => pick && panel.reveal());
			}
			const changed = values.filter(v => this.last.has(v.name) && this.last.get(v.name) !== v.value).map(v => v.name);
			values.forEach(v => this.last.set(v.name, v.value));
			void panel.webview.postMessage({
				type: 'state', name: target.name, address: target.address, network: net.label, hasAbi: !!abi, noCode: code === '0x',
				balance: `${Number(formatEther(BigInt(balance))).toLocaleString('en-US', { maximumFractionDigits: 6 })} LCAI`,
				values, changed, events: this.events, fresh: first ? [] : fresh.map(f => f.key), block: Number(latest), notify: this.notify,
			});
		} catch (err) {
			void panel.webview.postMessage({ type: 'offline', message: `The network did not answer: ${(err as Error).message.split('\n')[0]}` });
		}
		if (this.panel) {
			this.timer = setTimeout(() => void this.tick(), POLL_MS);
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

/** The tab's styles and script (exported for the script-compiles test). */
export const DASHBOARD_CSS = `
	.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; max-width: 1100px; align-items: start; }
	@media (max-width: 820px) { .grid { grid-template-columns: minmax(0, 1fr); } }
	.big { color: var(--lc-text-strong); font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; font-variant-numeric: tabular-nums; }
	.row .v { transition: color 1.2s ease; }
	.row.flash .v { color: #ff6fdc; }
	.ev { display: block; width: 100%; padding: 8px 10px; margin-top: 6px; border: 1px solid var(--zap); border-radius: 10px; background: transparent; color: var(--lc-text-primary); font-size: 12.5px; text-align: left; cursor: pointer; word-break: break-word; transition: border-color .2s ease, background .2s ease; }
	.ev:hover { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.06); }
	.ev.new { border-color: rgba(221, 0, 172, 0.5); }
	.ev small { display: block; margin-top: 2px; color: var(--lc-text-tertiary); font-size: 11.5px; }
	.live { display: inline-flex; align-items: center; gap: 6px; color: var(--lc-text-tertiary); font-size: 12px; }
	.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--lc-success); animation: pulse 2s ease infinite; }
	.live.off i { background: var(--lc-warning); animation: none; }
	@keyframes pulse { 50% { opacity: .35; } }
	.toggle { display: flex; align-items: center; gap: 10px; margin-top: 10px; color: var(--lc-text-secondary); font-size: 12.5px; cursor: pointer; }
`;

export const DASHBOARD_SCRIPT = `
	let built = false;
	window.addEventListener('message', e => {
		const m = e.data; if (!m) return;
		if (m.type === 'offline') { const l = document.querySelector('.live'); if (l) { l.classList.add('off'); l.lastChild.textContent = m.message; } return; }
		if (m.type !== 'state') return;
		$('title').textContent = (m.name || 'Contract') + ' — live';
		$('lead').textContent = 'Lightchain ' + m.network + ' · ' + m.address;
		if (!built) { built = true; $('actions').append(btn('Open on Lightscan', false, () => post('explorer')), btn('Interact', true, () => post('interact'))); }
		const body = $('body'); const top = body.scrollTop; body.replaceChildren();
		const grid = el('div', 'grid'); const left = el('div', 'p-col'), right = el('div', 'p-col'); grid.append(left, right); body.append(grid);
		const bal = panel('Holds'); bal.append(el('div', 'big', m.balance));
		const live = el('span', 'live'); live.append(el('i'), 'Live · block ' + m.block.toLocaleString()); live.style.marginTop = '8px'; bal.append(live);
		left.append(bal);
		if (m.noCode) left.append(el('div', 'say bad', 'There is no contract at this address on ' + m.network + '. It may be on the other network.'));
		const vals = panel('Right now');
		if (!m.hasAbi) vals.append(el('div', 'note', 'Build the project (or name this contract like the one in your code) to see its values here.'));
		else if (!m.values.length) vals.append(el('div', 'note', 'This contract has no values that can be read without arguments.'));
		m.values.forEach(v => { const r = row(v.name, v.value, true); if (m.changed.includes(v.name)) { r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 1500); } vals.append(r); });
		left.append(vals);
		const ev = panel('What it announced (events)');
		if (!m.events.length) ev.append(el('div', 'note', 'No events in the last blocks. When someone uses the contract, what it announces shows up here.'));
		m.events.forEach(x => { const b = el('button', 'ev mono' + (m.fresh.includes(x.key) ? ' new' : ''), x.text); b.type = 'button'; b.title = 'Debug this transaction'; b.append(el('small', '', 'block ' + x.block.toLocaleString() + ' · ' + x.tx.slice(0, 10) + '…')); b.onclick = () => post('tx', { hash: x.tx }); ev.append(b); });
		const tg = el('label', 'toggle'); const cb = el('span', 'check' + (m.notify ? ' on' : ''), '✓'); tg.append(cb, 'Tell me about new events when this tab is in the background');
		tg.onclick = () => { m.notify = !m.notify; cb.classList.toggle('on', m.notify); post('notify', { on: m.notify }); };
		ev.append(tg); right.append(ev);
		body.scrollTop = top;
	});
`;
