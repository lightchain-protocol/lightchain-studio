import * as vscode from 'vscode';
import { NetworkState } from '../networkState';
import { txUrl } from '../networks';
import { page } from '../ui/page';
import { ProjectAbis } from './projectAbis';
import { TxReport, inspectTx } from './txDebug';

/**
 * Transaction debugger tab: paste a transaction hash (or open one from a
 * failure) and read what it did, and if it failed, why and where.
 */
export class TxPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private report?: TxReport;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly network: NetworkState,
		private readonly abis: ProjectAbis,
		private readonly names: () => Map<string, string>,
		private readonly ask: (request: string) => Promise<void>,
	) { }

	async open(hash?: string): Promise<void> {
		const given = typeof hash === 'string' ? hash.trim() : await vscode.window.showInputBox({
			title: 'Debug a transaction', prompt: `Paste a transaction hash from Lightchain ${this.network.current.label}`, placeHolder: '0x…', ignoreFocusOut: true,
			validateInput: v => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? undefined : 'A transaction hash is 0x followed by 64 characters.',
		});
		if (!given) {
			return;
		}
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('lightchain.tx', 'Transaction', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.webview.html = page(this.panel.webview, this.extensionUri, { title: 'Transaction debugger', lead: 'What a transaction did, and if it failed, why.', css: TX_CSS, script: TX_SCRIPT });
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		}
		this.panel.reveal(vscode.ViewColumn.Active);
		await this.load(given);
	}

	private post(m: unknown): void {
		void this.panel?.webview.postMessage(m);
	}

	private async load(hash: string): Promise<void> {
		const net = this.network.current;
		this.report = undefined;
		this.post({ type: 'state', loading: true, hash, network: net.label });
		try {
			this.report = await inspectTx(net.rpcUrl, hash, await this.abis.index(), this.names());
			this.post({ type: 'state', report: this.report, hash, network: net.label, canOpen: !!(this.report.call && (this.report.toName ?? this.report.call.contract)) });
		} catch (err) {
			this.post({ type: 'state', error: `Could not read the transaction: ${(err as Error).message.split('\n')[0]}`, hash, network: net.label });
		}
	}

	private async onMessage(m: any): Promise<void> {
		const r = this.report;
		switch (m?.type) {
			case 'ready':
				return r ? this.post({ type: 'state', report: r, hash: r.hash, network: this.network.current.label, canOpen: !!(r.call && (r.toName ?? r.call.contract)) }) : undefined;
			case 'another':
				return this.open();
			case 'explorer':
				return r ? void vscode.env.openExternal(vscode.Uri.parse(txUrl(this.network.current, r.hash))) : undefined;
			case 'explain':
				if (r) {
					const lines = [
						`Explain this Lightchain ${this.network.current.label} transaction${r.status === 'failed' ? ' and how to fix what went wrong' : ''}, in simple words.`,
						`Transaction ${r.hash}: ${r.summary}`,
						...(r.revert ? [`Revert: ${r.revert.text}`] : []),
						...(r.trace.length ? ['Call trace:', ...r.trace.slice(0, 12).map(t => `${'  '.repeat(t.depth)}${t.toName ?? t.to} · ${t.text}${t.failed ? ` — failed: ${t.failed}` : ''}`)] : []),
					];
					await this.ask(lines.join('\n'));
				}
				return;
			case 'source':
				return r?.call ? this.openFunction(r.toName ?? r.call.contract, r.call.name) : undefined;
		}
	}

	/** Opens the function that was called, in the project's source. */
	private async openFunction(contract: string | undefined, fn: string): Promise<void> {
		const source = contract ? (await this.abis.index()).byName(contract)?.source : undefined;
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!source || !root) {
			vscode.window.showInformationMessage(`The source of ${contract ?? 'this contract'} is not in this project.`);
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, source));
		const at = doc.getText().search(new RegExp(`\\bfunction\\s+${fn}\\b`));
		const pos = doc.positionAt(Math.max(0, at));
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

/** The tab's styles and script (exported for the script-compiles test). */
export const TX_CSS = `
	.trace { font-size: 12.5px; line-height: 1.7; }
	.trace div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--lc-text-secondary); }
	.trace .bad { color: #fecaca; }
	.trace b { color: var(--lc-text-primary); font-weight: 500; }
	.ev { padding: 6px 0; font-size: 13px; color: var(--lc-text-primary); word-break: break-word; }
	.ev + .ev { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.ev small { display: block; color: var(--lc-text-tertiary); font-size: 12px; }
`;

export const TX_SCRIPT = `
	window.addEventListener('message', e => {
		const m = e.data; if (!m || m.type !== 'state') return;
		const body = $('body'), actions = $('actions'); body.replaceChildren(); actions.replaceChildren();
		$('lead').textContent = 'Lightchain ' + m.network + ' · ' + m.hash.slice(0, 12) + '…' + m.hash.slice(-10);
		const col = el('div', 'p-col'); body.append(col);
		actions.append(btn('Another transaction', false, () => post('another')));
		if (m.loading) { col.append(el('div', 'say', 'Reading the transaction from the network…')); return; }
		if (m.error) { col.append(el('div', 'notice error', m.error)); return; }
		const r = m.report;
		if (r.status !== 'missing') { actions.append(btn('Open on Lightscan', false, () => post('explorer')), btn(r.status === 'failed' ? 'Ask Lightchain AI to fix it' : 'Explain with Lightchain AI', true, () => post('explain'))); }
		// a failure or something still open is a notice; a success is said plainly, with the accent chip
		const head = el('div', r.status === 'failed' ? 'notice error' : r.status === 'success' ? 'say' : 'notice warn');
		if (r.status === 'success') { const p = el('span', 'pill on', 'Worked'); p.style.marginRight = '10px'; head.append(p); }
		head.append(r.summary); col.append(head);
		if (r.status === 'missing') return;
		if (r.revert) {
			const why = panel('Why it failed'); why.append(row('In plain words', r.revert.plain), row('The contract said', r.revert.text, true));
			if (r.outOfGas) why.append(row('Gas', 'All of the gas limit was used (' + r.gasUsed.toLocaleString() + ' of ' + r.gasLimit.toLocaleString() + ')'));
			if (m.canOpen) { const b = btn('Open ' + r.call.name + '() in the code', false, () => post('source')); b.style.marginTop = '10px'; why.append(b); }
			col.append(why);
		}
		const what = panel('What was sent');
		what.append(row('Transaction', r.hash, true));
		what.append(row('From', r.from, true));
		if (r.to) what.append(row('To', (r.toName ? r.toName + ' · ' : '') + r.to, true));
		if (r.created) what.append(row('Created', r.created, true));
		if (r.call) what.append(row('Function', r.call.signature, true));
		(r.call ? r.call.args : []).forEach(a => what.append(row('  ' + a.name, a.value, true)));
		if (r.selector) what.append(row('Function', r.selector + ' (not in this project)', true));
		what.append(row('Value', r.value));
		if (r.gasUsed !== undefined) what.append(row('Gas used', r.gasUsed.toLocaleString() + (r.gasLimit ? ' of ' + r.gasLimit.toLocaleString() : '')));
		if (r.fee) what.append(row('Fee', r.fee));
		if (r.block) what.append(row('Block', String(r.block)));
		if (!r.revert && m.canOpen) { const b = btn('Open ' + r.call.name + '() in the code', false, () => post('source')); b.style.marginTop = '10px'; what.append(b); }
		col.append(what);
		if (r.events.length) {
			const ev = panel('What it announced (events)');
			r.events.forEach(x => { const d = el('div', 'ev mono', x.text); d.append(el('small', '', (x.contract ? x.contract + ' · ' : '') + x.address)); ev.append(d); });
			col.append(ev);
		}
		if (r.trace.length > 1) {
			const tr = panel('Step by step (call trace)'); const box = el('div', 'trace mono');
			r.trace.forEach(t => { const d = el('div', t.failed ? 'bad' : ''); d.style.paddingLeft = (t.depth * 18) + 'px'; d.append(el('b', '', (t.toName || t.to.slice(0, 10) + '…') + ' '), t.text + (t.value ? ' · ' + t.value : '') + (t.failed ? ' — ' + t.failed : '')); box.append(d); });
			tr.append(box); col.append(tr);
		}
	});
`;
