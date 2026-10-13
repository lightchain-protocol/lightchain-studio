import * as vscode from 'vscode';
import { page } from '../ui/page';
import { MapContract, contractMap, describeContract, plainName } from './graph';

/**
 * Contract map tab: the project's contracts as cards — what builds on what, and
 * for each function who may call it and whether money moves. Click a function
 * to open it; ask Lightchain AI about a contract from its card.
 */
export class MapPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private timer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly files: () => Promise<{ path: string; text: string }[]>,
		private readonly deployed: () => { name?: string; address: string }[],
		private readonly ask: (request: string, file?: string) => Promise<void>,
		/** Serious security findings in a file (shown on its contracts). */
		private readonly serious: (file: string) => Promise<number> = async () => 0,
	) {
		const later = () => { clearTimeout(this.timer); this.timer = setTimeout(() => void this.push(), 600); };
		this.disposables.push(vscode.workspace.onDidSaveTextDocument(d => { if (this.panel && d.fileName.endsWith('.sol')) { later(); } }));
	}

	open(): void {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('lightchain.map', 'Contract map', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.webview.html = page(this.panel.webview, this.extensionUri, { title: 'Contract map', lead: 'Each contract in plain words: what anyone can do, what only some can, and where money moves.', css: MAP_CSS, script: MAP_SCRIPT });
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		}
		this.panel.reveal(vscode.ViewColumn.Active);
		void this.push();
	}

	private async contracts(): Promise<MapContract[]> {
		const own = (await this.files()).filter(f => !/(^|\/)(test|script|lib)\//.test(f.path) && !/\.(t|s)\.sol$/.test(f.path));
		return contractMap(own);
	}

	private async push(): Promise<void> {
		const contracts = await this.contracts().catch(() => []);
		const live = this.deployed();
		const problems = new Map<string, number>();
		for (const file of new Set(contracts.map(c => c.file))) {
			problems.set(file, await this.serious(file).catch(() => 0));
		}
		void this.panel?.webview.postMessage({
			type: 'state',
			contracts: contracts.map(c => ({
				...c, deployed: live.find(d => d.name === c.name)?.address, about: describeContract(c), problems: problems.get(c.file) ?? 0,
				functions: c.functions.map(f => ({ ...f, label: plainName(f.name) })),
			})),
		});
	}

	private async onMessage(m: any): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		switch (m?.type) {
			case 'ready':
				return this.push();
			case 'open': {
				if (!root) {
					return;
				}
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, String(m.file)));
				const line = Math.max(0, Number(m.line) - 1);
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(line, 0, line, 0) });
				return;
			}
			case 'fix':
				return void vscode.commands.executeCommand('lightchain.security.fixAll', String(m.file));
			case 'ask':
				return this.ask(`Explain the ${m.name} contract to someone new to it: what it is for, who may call each function, and where money can move in or out. Point out anything risky.`, String(m.file));
			case 'dashboard':
				return void vscode.commands.executeCommand('lightchain.dashboard.open', String(m.address), String(m.name));
			case 'new':
				return void vscode.commands.executeCommand('lightchain.project.new');
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

/** The tab's styles and script (exported for the script-compiles test). */
export const MAP_CSS = `
	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; align-items: start; max-width: 1200px; }
	.card { padding: 0; border: 1px solid var(--zap); border-radius: 14px; background: var(--lc-surface-2); overflow: hidden; scroll-margin-top: 16px; transition: border-color .3s ease; }
	.card.flash { border-color: var(--lc-accent); }
	.card__head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 0; }
	.card__mark { flex: none; width: 36px; height: 36px; border-radius: var(--lc-radius-sm); overflow: hidden; background: var(--lc-surface-3); }
	.card__mark svg { width: 100%; height: 100%; display: block; }
	.card__name { color: var(--lc-text-strong); font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
	.card__sub { color: var(--lc-text-tertiary); font-size: 12px; }
	.card__about { margin: 12px 16px 0; color: var(--lc-text-primary); font-size: 13.5px; line-height: 1.55; }
	.links { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 16px 0; }
	.linkchip { padding: 2px 10px; border: 1px solid rgba(112, 100, 233, 0.24); border-radius: 999px; background: var(--lc-surface-hover); color: var(--lc-text-secondary); font-size: 12px; cursor: pointer; transition: border-color .2s ease; }
	.linkchip:hover { border-color: var(--zap-strong); }
	.linkchip.static { cursor: default; }
	.warn { display: flex; align-items: center; gap: 10px; margin: 12px 16px 0; padding: 8px 12px; border-radius: 10px; background: rgba(255, 42, 39, 0.08); color: #ff8a88; font-size: 12.5px; }
	.warn span { flex: 1; }
	.group { margin-top: 14px; padding: 0 8px; }
	.group__title { padding: 0 8px 4px; color: var(--lc-text-tertiary); font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; }
	.fn { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 6px 8px; border: 0; border-radius: var(--lc-radius-sm); background: transparent; color: var(--lc-text-primary); font-size: 13.5px; text-align: left; cursor: pointer; transition: background .2s ease; }
	.fn:hover { background: var(--lc-surface-3); }
	.fn .n { flex: 1; min-width: 0; }
	.fn .n::first-letter { text-transform: uppercase; }
	.fn .tag { color: var(--lc-text-tertiary); font-size: 12px; white-space: nowrap; }
	.fn .tag.money { color: #ff6fdc; }
	.card__foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; padding: 10px 14px 14px; border-top: 1px solid var(--lc-rule); }
`;

export const MAP_SCRIPT = `
	const KIND = { contract: 'Contract', abstract: 'Building block', interface: 'Interface', library: 'Library' };
	const GROUPS = [['anyone', 'Anyone can'], ['restricted', 'Only the owner or allowed callers can'], ['read', 'Anyone can look up']];
	const jump = name => { const c = document.querySelector('[data-contract="' + name + '"]'); if (!c) return; c.scrollIntoView({ behavior: 'smooth', block: 'start' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1200); };
	window.addEventListener('message', e => {
		const m = e.data; if (!m || m.type !== 'state') return;
		const data = m.contracts, known = new Set(data.map(c => c.name));
		const body = $('body'); const top = body.scrollTop; body.replaceChildren();
		if (!data.length) {
			const em = el('div', 'empty'); em.append(el('h2', '', 'No contracts yet'), el('p', '', 'Add a Solidity contract to src/ and it shows up here, explained in plain words.'), btn('New project', true, () => post('new'))); body.append(em); return;
		}
		const cards = el('div', 'cards');
		data.forEach(c => {
			const card = el('div', 'card'); card.dataset.contract = c.name;
			const head = el('div', 'card__head'); const mark = el('span', 'card__mark'); mark.innerHTML = lcIdenticon('contract:' + c.name);
			const t = el('div'); t.append(el('div', 'card__name', c.name), el('div', 'card__sub', KIND[c.kind] + ' · ' + c.file));
			head.append(mark, t); if (c.deployed) { const p = el('span', 'pill ok', 'Live'); p.title = 'Deployed at ' + c.deployed; p.style.marginLeft = 'auto'; head.append(p); }
			card.append(head, el('div', 'card__about', c.about));
			if (c.bases.length || c.uses.length) {
				const links = el('div', 'links');
				const chip = (prefix, name) => { const b = el('button', 'linkchip' + (known.has(name) ? '' : ' static'), prefix + ' ' + name); b.type = 'button'; if (known.has(name)) { b.title = 'Show ' + name; b.onclick = () => jump(name); } else { b.title = name + ' comes from a library, not from this project'; } return b; };
				c.bases.forEach(b => links.append(chip('Builds on', b))); c.uses.forEach(u => links.append(chip('Uses', u)));
				card.append(links);
			}
			if (c.problems) { const w = el('div', 'warn'); w.append(el('span', '', c.problems + ' serious security problem' + (c.problems === 1 ? '' : 's') + ' in this file')); const b = el('button', 'button button-xs', 'Fix with AI'); b.onclick = () => post('fix', { file: c.file }); w.append(b); card.append(w); }
			GROUPS.forEach(([who, title]) => {
				const fns = c.functions.filter(f => f.who === who); if (!fns.length) return;
				const g = el('div', 'group'); g.append(el('div', 'group__title', title));
				fns.forEach(f => {
					const b = el('button', 'fn'); b.type = 'button'; b.title = 'Open ' + f.name + '() in the code' + (f.guard && f.guard !== 'checks the caller' ? ' — protected by ' + f.guard : '');
					b.append(el('span', 'n', f.label));
					const money = [f.payable ? 'takes LCAI in' : '', f.sends ? 'pays out' : ''].filter(Boolean).join(' · ');
					if (money) b.append(el('span', 'tag money', money));
					b.onclick = () => post('open', { file: c.file, line: f.line }); g.append(b);
				});
				card.append(g);
			});
			const foot = el('div', 'card__foot');
			const open = el('button', 'button button-xs', 'Open the code'); open.onclick = () => post('open', { file: c.file, line: c.line });
			const ask = el('button', 'button button-xs', 'Explain with Lightchain AI'); ask.onclick = () => post('ask', { name: c.name, file: c.file });
			foot.append(open, ask);
			if (c.deployed) { const dash = el('button', 'button button-xs', 'Watch it live'); dash.onclick = () => post('dashboard', { address: c.deployed, name: c.name }); foot.append(dash); }
			card.append(foot); cards.append(card);
		});
		body.append(cards); body.scrollTop = top;
	});
`;
