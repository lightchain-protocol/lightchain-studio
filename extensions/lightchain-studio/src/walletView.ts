import * as vscode from 'vscode';
import { formatEther } from 'viem';
import { Credits, jobFee } from './credits';
import { claimTestnetLcai } from './faucet';
import { addressUrl, txUrl } from './networks';
import { NetworkState } from './networkState';
import { UsageReader } from './usage';
import { Wallet } from './wallet';
import { IDENTICON_JS, siteCss } from './ui/site';

/**
 * The Explorer's Wallet section: the connected wallets with their LCAI, and the
 * active one's Lightchain AI credits — balance, what it has spent and roughly how
 * many requests are left. Everything is read from Lightchain itself (RPC + the
 * JobRegistry's events), never from a Lightchain server. Topping up, withdrawing
 * and the testnet faucet happen in place, without VS Code prompts.
 */
export class WalletView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly usage: UsageReader;
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;

	constructor(private readonly extensionUri: vscode.Uri, private readonly wallet: Wallet, private readonly network: NetworkState, private readonly credits: Credits, memento: vscode.Memento) {
		this.usage = new UsageReader(memento);
		this.disposables.push(wallet.onDidChange(() => this.refreshSoon()), network.onDidChange(() => this.refreshSoon()), credits.onDidChange(() => this.refreshSoon()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		view.onDidChangeVisibility(() => view.visible && this.refresh(), undefined, this.disposables);
	}

	refreshSoon(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.refresh(), 250);
	}

	private post(m: unknown): void {
		void this.view?.webview.postMessage(m);
	}

	private async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}
		const gen = ++this.generation;
		const net = this.network.current;
		const active = this.wallet.active;
		const accounts = this.wallet.all.map(a => ({ id: a.id, name: a.name, kind: a.kind, address: a.address, active: a.id === active?.id }));
		// draw the rows straight away, then fill in what the chain says
		this.post({ type: 'state', network: { id: net.id, label: net.label }, accounts, loading: true });
		const client = this.wallet.publicClient(net);
		const balances = await Promise.all(accounts.map(a => client.getBalance({ address: a.address }).then(b => lcai(b), () => null)));
		let credits: Record<string, unknown> | null = null;
		if (active) {
			try {
				const snap = await this.credits.read(active, net);
				const used = await this.usage.read(client as never, net, active.address, snap.credits).catch(() => null);
				const left = Number(formatEther(snap.credits));
				credits = {
					balance: lcai(snap.credits), requests: Math.floor(left / jobFee(net) + 1e-9),
					spent: used ? lcai(used.spent) : null, deposited: used ? lcai(used.deposited) : null, withdrawn: used ? lcai(used.withdrawn) : null,
					spentRequests: used ? Math.round(Number(formatEther(used.spent)) / jobFee(net)) : null,
					wallet: lcai(snap.walletBalance), lightscan: addressUrl(net, active.address),
				};
			} catch {
				credits = { error: 'Could not reach Lightchain. Check your connection and try again.' };
			}
		}
		if (gen === this.generation) {
			this.post({ type: 'state', network: { id: net.id, label: net.label }, accounts: accounts.map((a, i) => ({ ...a, lcai: balances[i] })), credits, loading: false });
		}
	}

	private async onMessage(m: any): Promise<void> {
		const run = (cmd: string, ...args: unknown[]) => void vscode.commands.executeCommand(cmd, ...args);
		switch (m?.type) {
			case 'ready':
				return this.refresh();
			case 'select':
				if (typeof m.id === 'string') {
					await this.wallet.select(m.id);
				}
				return;
			case 'copy':
				if (typeof m.address === 'string') {
					await vscode.env.clipboard.writeText(m.address);
					this.post({ type: 'copied', address: m.address });
				}
				return;
			case 'connect':
				return run('lightchain.wallet.connectBrowser');
			case 'more':
				return run('lightchain.wallet.menu');
			case 'network':
				return run(m.id === 'mainnet' ? 'lightchain.network.useMainnet' : 'lightchain.network.useTestnet');
			case 'open':
				if (typeof m.url === 'string' && /^https:\/\/[a-z]+\.lightscan\.app\//.test(m.url)) {
					return void vscode.env.openExternal(vscode.Uri.parse(m.url));
				}
				return;
			case 'faucet': {
				const acc = this.wallet.active;
				if (!acc || this.network.current.id !== 'testnet') {
					return;
				}
				this.post({ type: 'busy', what: 'faucet' });
				const res = await claimTestnetLcai(acc.address);
				this.post({ type: 'result', ok: res.ok, text: res.message });
				if (res.ok) {
					setTimeout(() => this.refresh(), 6_000);
					setTimeout(() => this.refresh(), 15_000);
				}
				return;
			}
			case 'topUp':
			case 'withdraw': {
				const acc = this.wallet.active;
				const amount = String(m.amount ?? '').trim();
				if (!acc || !/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
					return this.post({ type: 'result', ok: false, text: 'Enter an LCAI amount, e.g. 1 or 0.5.' });
				}
				const net = this.network.current;
				this.post({ type: 'busy', what: m.type, text: acc.kind === 'browser' ? 'Approve it in your browser wallet…' : 'Sending to Lightchain…' });
				try {
					const hash = m.type === 'topUp' ? await this.credits.topUp(acc, net, amount) : await this.credits.withdraw(acc, net, amount);
					this.post({ type: 'result', ok: true, text: m.type === 'topUp' ? `Added ${amount} LCAI to your AI credits.` : `Moved ${amount} LCAI back to your wallet.`, url: txUrl(net, hash) });
				} catch (err) {
					this.post({ type: 'result', ok: false, text: plain((err as Error).message) });
				}
				return this.refresh();
			}
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	${siteCss(String(media('Inter-latin.woff2')))}
	body { padding: 8px 12px 16px; animation: fadeIn var(--lc-motion) ease; }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	.row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 8px; }

	/* .chip (P2P kit.css): the network switch */
	.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid rgba(91, 75, 255, 0.15); border-radius: 52px; background: var(--lc-surface-2); color: var(--lc-text-primary); font-size: 11px; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; white-space: nowrap; cursor: pointer; transition: border-color var(--lc-motion-base) ease; }
	.chip:hover { border-color: var(--lc-accent); }
	.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lc-success); }
	.chip.mainnet .dot { background: var(--lc-warning); }

	/* wallets: the P2P account pill as a list row */
	.accounts { display: flex; flex-direction: column; gap: 6px; }
	.acct { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 1px solid rgba(91, 75, 255, 0.15); border-radius: var(--lc-radius-md); background: var(--lc-surface-2); color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: border-color var(--lc-motion-base) ease; }
	.acct:hover { border-color: var(--lc-accent); }
	.acct.active { border-color: var(--lc-accent); box-shadow: inset 3px 0 0 var(--lc-accent); }
	.acct .mark { flex: none; width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: var(--lc-surface-3); }
	.acct .mark svg { width: 100%; height: 100%; display: block; }
	.acct .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
	.acct .name { font-size: 12px; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.acct .addr { font-family: Menlo, Monaco, monospace; font-size: 11px; color: var(--lc-text-tertiary); white-space: nowrap; }
	.acct .bal { flex: none; text-align: right; font-size: 12px; color: var(--lc-text-primary); white-space: nowrap; }
	.acct .bal small { display: block; font-size: 10px; color: var(--lc-text-tertiary); letter-spacing: 0.5px; text-transform: uppercase; }
	.acct .copy { position: absolute; right: 8px; top: 6px; display: none; padding: 2px 6px; border: 0; border-radius: 4px; background: var(--lc-surface-3); color: var(--lc-text-tertiary); font-size: 10px; cursor: pointer; }
	.acct:hover .copy { display: block; }
	.acct:hover .bal { visibility: hidden; }
	.add { display: flex; gap: 6px; margin-top: 8px; }
	.add .button { flex: 1; }

	/* AI credits: the P2P wallet's "AI credit" card (.kit-card + .facts) */
	.card { margin-top: 16px; padding: 14px; border-radius: var(--lc-radius-group); border-color: rgba(112, 100, 233, 0.18); }
	.card-title { margin: 0 0 6px; font-size: 11px; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; color: var(--lc-text-secondary); }
	.big { display: flex; align-items: baseline; gap: 6px; color: var(--lc-text-strong); font-size: 24px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
	.big small { font-size: 12px; font-weight: 500; color: var(--lc-text-tertiary); letter-spacing: 0.5px; }
	.hint { margin-top: 2px; color: var(--lc-text-tertiary); font-size: 12px; }
	.meter { height: 4px; margin: 12px 0 2px; border-radius: 2px; background: rgba(204, 206, 239, 0.08); overflow: hidden; }
	.meter > i { display: block; height: 100%; border-radius: 2px; background: var(--lc-grad-brand); transition: width var(--lc-motion-base) ease; }
	.facts { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; margin: 12px 0 0; font-size: 12px; }
	.facts dt { color: var(--lc-text-tertiary); }
	.facts dd { margin: 0; text-align: right; color: var(--lc-text-primary); white-space: nowrap; }
	.actions { display: flex; gap: 6px; margin-top: 14px; }
	.actions .button { flex: 1; }
	.amount { display: none; margin-top: 10px; gap: 6px; }
	.amount.open { display: flex; }
	.amount .input { height: 32px; padding: 0 10px; font-size: 12px; }
	.amount .button { flex: none; }
	.note { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--lc-text-secondary); }
	.note.ok { color: var(--lc-success); }
	.note.err { color: var(--lc-danger); }
	.note a, .foot a { color: var(--lc-text-primary); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
	.foot { margin-top: 12px; color: var(--lc-text-tertiary); font-size: 11px; line-height: 1.5; }
	.empty { padding: 14px; border: 1px dashed var(--lc-rule-strong); border-radius: var(--lc-radius-md); color: var(--lc-text-secondary); font-size: 12px; text-align: center; }
	.empty .button { margin-top: 10px; }
	.skeleton { display: inline-block; width: 46px; height: 10px; border-radius: 3px; background: rgba(204, 206, 239, 0.08); animation: pulse 1.2s ease-in-out infinite; }
	@keyframes pulse { 50% { opacity: .4; } }
</style>
</head>
<body>
	<div class="row-head"><span class="group-title">Wallets</span><button class="chip" id="net" title="Switch network"><span class="dot"></span><span id="netLabel">Testnet</span></button></div>
	<div class="accounts" id="accounts"></div>
	<div class="add" id="add">
		<button class="button button-sm" id="connect">Connect wallet</button>
		<button class="button button-sm" id="more">More</button>
	</div>
	<div id="credits"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	const short = a => a.slice(0, 6) + '…' + a.slice(-4);
	let state = null, panel = '', note = null, busy = false;

	$('net').onclick = () => state && vscode.postMessage({ type: 'network', id: state.network.id === 'testnet' ? 'mainnet' : 'testnet' });
	$('connect').onclick = () => vscode.postMessage({ type: 'connect' });
	$('more').onclick = () => vscode.postMessage({ type: 'more' });

	function renderAccounts() {
		const list = $('accounts'); list.replaceChildren();
		$('netLabel').textContent = state.network.label;
		$('net').className = 'chip ' + state.network.id;
		$('add').style.display = state.accounts.length ? 'flex' : 'none';
		if (!state.accounts.length) {
			const e = el('div', 'empty');
			e.append(el('div', '', 'Connect a wallet to deploy contracts and pay for Lightchain AI.'));
			const b = el('button', 'button button-primary button-sm button-block', 'Connect wallet');
			b.onclick = () => vscode.postMessage({ type: 'connect' });
			const more = el('button', 'link', 'or create a new account');
			more.style.marginTop = '8px';
			more.onclick = () => vscode.postMessage({ type: 'more' });
			e.append(b, more);
			list.append(e);
			return;
		}
		for (const a of state.accounts) {
			const row = el('button', 'acct' + (a.active ? ' active' : ''));
			row.title = a.active ? 'Active account' : 'Use this account';
			const mark = el('span', 'mark'); mark.innerHTML = lcIdenticon(a.address);
			const body = el('span', 'body');
			body.append(el('span', 'name', a.name), el('span', 'addr', short(a.address)));
			const bal = el('span', 'bal');
			if (a.lcai === undefined) bal.append(el('span', 'skeleton'));
			else bal.append(document.createTextNode(a.lcai === null ? '—' : a.lcai), el('small', '', a.kind === 'browser' ? 'Browser' : 'In Studio'));
			const copy = el('span', 'copy', 'Copy');
			copy.onclick = ev => { ev.stopPropagation(); vscode.postMessage({ type: 'copy', address: a.address }); };
			row.append(mark, body, bal, copy);
			row.onclick = () => !a.active && vscode.postMessage({ type: 'select', id: a.id });
			list.append(row);
		}
	}

	function renderCredits() {
		const box = $('credits'); box.replaceChildren();
		if (!state.accounts.length) return;
		const c = state.credits;
		const card = el('div', 'card');
		card.append(el('p', 'card-title', 'Lightchain AI credits'));
		if (c && c.error) {
			card.append(el('div', 'note err', c.error));
			box.append(card); return;
		}
		const big = el('div', 'big');
		if (!c) big.append(el('span', 'skeleton'));
		else big.append(document.createTextNode(c.balance), el('small', '', 'LCAI'));
		card.append(big);
		if (c) {
			card.append(el('div', 'hint', c.requests > 0 ? 'About ' + c.requests + ' AI request' + (c.requests === 1 ? '' : 's') + ' left' : 'Add credits to use Lightchain AI'));
			const total = Number(c.spent ?? 0) + Number(c.balance);
			const meter = el('div', 'meter'); const fill = el('i');
			fill.style.width = (total > 0 ? Math.max(2, Math.min(100, Number(c.balance) / total * 100)) : 0) + '%';
			meter.append(fill); card.append(meter);
			const facts = el('dl', 'facts');
			const fact = (k, v) => facts.append(el('dt', '', k), el('dd', '', v));
			fact('Spent on AI', c.spent === null ? '—' : c.spent + ' LCAI' + (c.spentRequests ? ' · ~' + c.spentRequests + ' req' : ''));
			fact('Added in total', c.deposited === null ? '—' : c.deposited + ' LCAI');
			if (c.withdrawn && c.withdrawn !== '0') fact('Taken back', c.withdrawn + ' LCAI');
			fact('In your wallet', c.wallet + ' LCAI');
			card.append(facts);
		}
		const actions = el('div', 'actions');
		const top = el('button', 'button button-primary button-sm', 'Add credits');
		const back = el('button', 'button button-sm', 'Withdraw');
		top.onclick = () => { panel = panel === 'topUp' ? '' : 'topUp'; note = null; render(); };
		back.onclick = () => { panel = panel === 'withdraw' ? '' : 'withdraw'; note = null; render(); };
		top.disabled = back.disabled = busy;
		actions.append(top, back);
		card.append(actions);
		if (panel) {
			const row = el('div', 'amount open');
			const input = el('input', 'input'); input.placeholder = 'Amount in LCAI'; input.inputMode = 'decimal';
			if (panel === 'withdraw' && c) input.value = c.balance.replace(/,/g, '');
			const go = el('button', 'button button-sm' + (panel === 'topUp' ? ' button-primary' : ''), panel === 'topUp' ? 'Add' : 'Withdraw');
			const submit = () => vscode.postMessage({ type: panel, amount: input.value });
			go.onclick = submit; input.onkeydown = e => e.key === 'Enter' && submit();
			go.disabled = busy;
			row.append(input, go); card.append(row);
			if (panel === 'topUp' && state.network.id === 'mainnet') card.append(el('div', 'note', 'Mainnet: this moves real LCAI from your wallet. You can withdraw unused credits any time.'));
			setTimeout(() => input.focus(), 0);
		}
		if (state.network.id === 'testnet') {
			const f = el('div', 'note');
			const a = el('a', '', busy === 'faucet' ? 'Claiming free test LCAI…' : 'Get free test LCAI');
			a.onclick = () => !busy && vscode.postMessage({ type: 'faucet' });
			f.append(a, document.createTextNode(' · 2 LCAI a day for gas and credits'));
			card.append(f);
		}
		if (note) {
			const n = el('div', 'note ' + (note.ok === true ? 'ok' : note.ok === false ? 'err' : ''), note.text + ' ');
			if (note.url) { const a = el('a', '', 'View on Lightscan'); a.onclick = () => vscode.postMessage({ type: 'open', url: note.url }); n.append(a); }
			card.append(n);
		}
		box.append(card);
		if (c && c.lightscan) {
			const foot = el('div', 'foot', 'Read directly from Lightchain — no account or server. ');
			const a = el('a', '', 'Verify on Lightscan'); a.onclick = () => vscode.postMessage({ type: 'open', url: c.lightscan });
			foot.append(a); box.append(foot);
		}
	}

	function render() { if (!state) return; renderAccounts(); renderCredits(); }

	window.addEventListener('message', ({ data: m }) => {
		if (m.type === 'state') {
			const prev = state;
			state = m;
			if (m.loading && prev) {
				// keep the numbers on screen while the chain is read again
				for (const a of state.accounts) { const p = prev.accounts.find(x => x.id === a.id); if (p) a.lcai = p.lcai; }
				if (prev.network.id === m.network.id && prev.accounts.find(a => a.active)?.id === m.accounts.find(a => a.active)?.id) state.credits = prev.credits;
			}
			render();
		} else if (m.type === 'busy') { busy = m.what; note = m.text ? { text: m.text } : null; render(); }
		else if (m.type === 'result') { busy = false; note = m; if (m.ok && panel) panel = ''; render(); }
		else if (m.type === 'copied') { note = { text: 'Address copied.' }; render(); setTimeout(() => { if (note && note.text === 'Address copied.') { note = null; render(); } }, 1500); }
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.disposables.forEach(d => d.dispose());
	}
}

function lcai(wei: bigint): string {
	const n = Number(formatEther(wei));
	return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 });
}

/** Wallet errors in plain words. */
function plain(message: string): string {
	if (/user rejected|denied|rejected the request/i.test(message)) {
		return 'Cancelled in your wallet.';
	}
	if (/insufficient funds|exceeds balance|InsufficientBalance/i.test(message)) {
		return 'Not enough LCAI for this amount plus gas.';
	}
	return message.split('\n')[0].slice(0, 200);
}
