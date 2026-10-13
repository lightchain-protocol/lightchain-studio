import * as vscode from 'vscode';
import * as path from 'node:path';
import { STATUSES, Task, TaskStore } from './tasks';
import { IDENTICON_JS, siteCss } from './ui/site';

/**
 * The Lightchain home sidebar (left): switch projects in one click, find
 * Lightchain AI chats (grouped by day) and keep the project's tasks at hand.
 */
export interface ChatSummary { id: string; title: string; updated: number; model?: string; files: number; current: boolean }

export interface ChatHost {
	chatList(): ChatSummary[];
	openChat(id: string): Promise<void>;
	newChat(): Promise<void>;
	runTask(task: Task): Promise<void>;
	readonly onDidChangeChats: vscode.Event<void>;
}

/** One step of the "Your first dApp" checklist. */
export interface StartStep { id: string; title: string; sub: string; done: boolean; command: string; action: string }

export class WorkspaceView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	/** The connected wallet for the account card (set by the extension). */
	account?: () => Promise<{ address: string; network: string; credits?: string } | undefined>;
	/** Deployed programs for the Deployed section (set by the extension). */
	programs?: () => { network: string; items: { name?: string; address: string; used: boolean }[]; other: { name?: string; address: string; used: boolean }[] };
	/** The first-dApp checklist for this project; undefined hides it (set by the extension). */
	steps?: () => Promise<StartStep[] | undefined>;
	/** The active wallet's own projects; undefined (no wallet, or none yet) falls back to recent ones (set by the extension). */
	walletProjects?: () => Promise<{ label: string; detail: string; uri: string }[] | undefined>;
	/** Every connected wallet, for the switcher on the account card (set by the extension). */
	wallets?: () => { id: string; name: string; address: string; active: boolean }[];
	selectWallet?: (id: string) => Promise<void>;
	private readonly disposables: vscode.Disposable[] = [];
	private timer?: ReturnType<typeof setTimeout>;

	constructor(private readonly extensionUri: vscode.Uri, private readonly chats: ChatHost, private readonly tasks: TaskStore) {
		this.disposables.push(chats.onDidChangeChats(() => this.refreshSoon()), tasks.onDidChange(() => this.refreshSoon()));
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

	private async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		void this.view.webview.postMessage({
			type: 'state',
			project: folder ? { name: folder.name, path: folder.uri.fsPath } : null,
			...await (async () => {
				const mine = await this.walletProjects?.().catch(() => undefined);
				const list = mine?.length ? mine : await recentProjects();
				return { recent: list.filter(r => r.uri !== folder?.uri.toString()), recentMine: !!mine?.length };
			})(),
			wallets: this.wallets?.() ?? [],
			programs: this.programs?.(),
			account: await this.account?.().catch(() => undefined),
			tasks: this.tasks.all.map(t => ({ id: t.id, key: `${this.tasks.prefix}-${t.key}`, title: t.title, status: t.status, priority: t.priority })),
			now: Date.now(),
		});
	}

	private async onMessage(m: any): Promise<void> {
		switch (m?.type) {
			case 'ready':
				return this.refresh();
			case 'switch':
				if (typeof m.uri === 'string') {
					// the window reloads into the project; the workbench shows the Lightchain loader meanwhile
					await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(m.uri), { forceReuseWindow: true });
				}
				return;
			case 'wallet':
				return typeof m.id === 'string' ? this.selectWallet?.(m.id) : undefined;
			case 'openFolder':
				return void vscode.commands.executeCommand('workbench.action.files.openFolder');
			case 'newProject':
				return void vscode.commands.executeCommand('lightchain.project.new');
			case 'board':
				return void vscode.commands.executeCommand('lightchain.tasks.board', typeof m.id === 'string' ? m.id : undefined);
			case 'newChat':
				return this.chats.newChat();
			case 'program': {
				const address = String(m.address ?? '');
				if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
					return;
				}
				if (m.action === 'call') {
					await vscode.commands.executeCommand('lightchain.programs.interactAddress', address, typeof m.name === 'string' ? m.name : undefined);
				} else if (m.action === 'lightscan') {
					await vscode.commands.executeCommand('lightchain.programs.openAddress', address);
				} else if (m.action === 'copy') {
					await vscode.env.clipboard.writeText(address);
					vscode.window.setStatusBarMessage('Address copied', 2000);
				}
				return;
			}
			case 'layout': {
				const right = 'workbench.view.extension.lightchain';
				const actions: Record<string, () => Thenable<unknown>> = {
					aiRight: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['lightchain.ai'], destinationId: right }),
					aiBottom: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['lightchain.ai'], destinationId: 'workbench.view.extension.lightchain-panel' }),
					terminalRight: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['terminal'], destinationId: right }),
					terminalBottom: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['terminal'], destinationId: 'terminal' }),
					contractsRight: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['lightchain.deployedPrograms'], destinationId: right }),
					contractsBottom: () => vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['lightchain.deployedPrograms'], destinationId: 'workbench.view.extension.lightchain-panel' }),
					left: () => vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'),
					bottom: () => vscode.commands.executeCommand('workbench.action.togglePanel'),
					rightSide: () => vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar'),
					reset: () => vscode.commands.executeCommand('workbench.action.resetViewLocations'),
				};
				const run = actions[String(m.action)];
				if (run) {
					await Promise.resolve(run()).then(undefined, err => vscode.window.showWarningMessage(`Could not change the layout: ${(err as Error)?.message ?? err}`));
				}
				return;
			}
			case 'run':
				if (typeof m.command === 'string' && (m.command.startsWith('lightchain.') || ['workbench.view.explorer', 'workbench.view.search', 'workbench.action.openSettings'].includes(m.command))) {
					await vscode.commands.executeCommand(m.command);
				}
				return;
			case 'openChat':
				if (typeof m.id === 'string') {
					await this.chats.openChat(m.id);
				}
				return;
			case 'addTask':
				if (typeof m.title === 'string' && m.title.trim()) {
					if (!vscode.workspace.workspaceFolders?.length) {
						vscode.window.showWarningMessage('Open a project to keep tasks with it.');
						return;
					}
					await this.tasks.add({ title: m.title });
				}
				return;
			case 'status': {
				const order = STATUSES.map(s => s.id);
				const t = this.tasks.all.find(x => x.id === m.id);
				if (t) {
					await this.tasks.move(t.id, order[(order.indexOf(t.status) + 1) % order.length]);
				}
				return;
			}
			case 'aiTask': {
				const t = this.tasks.all.find(x => x.id === m.id);
				if (t) {
					await this.chats.runTask(t);
				}
				return;
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
	html, body { height: 100%; }
	body { display: flex; flex-direction: column; overflow: hidden; background: var(--lc-surface-1); animation: fadeIn var(--lc-motion) ease; }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	/* .sidebar-head */
	.head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
	.head img { height: 18px; width: auto; display: block; }
	.head .suffix { color: var(--lc-text-tertiary); font-size: 15px; }

	.scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 8px 8px; }
	.group { display: flex; align-items: center; gap: 6px; padding: 14px 4px 6px; }
	.group .grow { flex: 1; }
	.group .note { color: var(--lc-text-tertiary); font-size: 12px; }
	.actions { display: flex; flex-direction: column; gap: 4px; padding: 2px 0 6px; }
	.list { display: flex; flex-direction: column; gap: 2px; }
	.empty { margin: 4px 4px 8px; color: var(--lc-text-tertiary); font-size: 13px; }

	/* project switcher */
	.project { margin-top: 4px; }
	.project .chev { margin-left: auto; }
	.menu { position: absolute; left: 8px; right: 8px; z-index: 20; padding: 6px; border: 1px solid var(--lc-rule); border-radius: var(--lc-radius-group); background: var(--lc-surface-2); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); animation: fadeIn var(--lc-motion) ease; }
	.menu[hidden] { display: none; }
	.menu.up { bottom: 64px; max-height: 60vh; overflow-y: auto; }
	.nav-item .tick { margin-left: auto; color: var(--lc-accent); font-size: 12px; }
	.menu .group { padding: 6px 6px 4px; }
	.sep { height: 1px; margin: 6px 0; background: var(--lc-rule); }

	/* compact rows inside lists */
	.nav-item.row { padding: 6px 8px; font-size: 14px; }
	.nav-item.row .nav-mark { width: 28px; height: 28px; }
	.nav-item.row .nav-name { font-size: 14px; }
	.nav-item.row .nav-sub { font-size: 12px; }
	.nav-item.is-active::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; border-radius: 2px; background: var(--lc-accent); }
	.icon-mark { color: var(--lc-text-tertiary); }
	.icon-mark svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
	.nav-item:hover .icon-mark, .nav-item.is-active .icon-mark { color: var(--lc-accent); }
	.row-acts { display: none; gap: 4px; margin-left: auto; }
	.nav-item:hover .row-acts { display: flex; }
	.row-acts .button { height: 24px; padding: 0 8px; font-size: 10.5px; }
	.state { margin-left: auto; flex: none; color: var(--lc-text-tertiary); font-size: 12px; font-weight: 400; }
	.nav-item:hover .state.hide { display: none; }
	.task .nav-icon { width: 15px; height: 15px; }
	.task.done .nav-label { color: var(--lc-text-tertiary); }
	.more { padding: 4px 8px; color: var(--lc-text-tertiary); font-size: 12px; cursor: pointer; transition: color var(--lc-motion); }
	.more:hover { color: var(--lc-text-primary); }
	.add { padding: 2px 0 4px; }
	.add[hidden] { display: none; }
	.search { padding: 0 0 6px; }
	.search[hidden] { display: none; }
	.search .input, .add .input { height: 32px; padding: 0 12px; font-size: 13px; }

	/* footer: workspace navigation + account (.sidebar footer) */
	.foot { flex: none; padding: 6px 8px 8px; border-top: 1px solid var(--lc-rule); }
	.foot .group { padding: 8px 4px 4px; }
	.nav-item.nav { padding: 7px 12px; }
	.account { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding: 8px; border-radius: var(--lc-radius-sm); cursor: pointer; transition: background 400ms; }
	.account:hover { background: var(--lc-surface-2); }
	.account .nav-mark { width: 28px; height: 28px; }
	.account .nav-name { font-size: 13px; }
	.account .nav-sub { font-size: 12px; }
	.gear { flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--lc-radius-sm); background: none; color: var(--lc-text-tertiary); cursor: pointer; transition: all 400ms; }
	.gear:hover { background: var(--lc-surface-2); color: var(--lc-accent); }
	.gear svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

	/* layout options */
	.layout { margin: 4px 0 6px; padding: 12px; border-radius: 12px; border: 1px solid rgba(112, 100, 233, 0.18); background: rgba(204, 206, 239, 0.03); animation: fadeIn var(--lc-motion) ease; }
	.layout[hidden] { display: none; }
	.lrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; }
	.lrow + .lrow { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.lrow > span { color: var(--lc-text-primary); font-size: 13px; }
	.seg { display: inline-flex; padding: 2px; border-radius: 8px; border: 1px solid rgba(112, 100, 233, 0.24); background: var(--lc-surface-hover); }
	.seg button { padding: 3px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--lc-text-tertiary); font-size: 11.5px; cursor: pointer; transition: all .2s ease; }
	.seg button:hover { color: var(--lc-text-primary); }
	.seg button.on { background: var(--lc-grad-brand); color: #fff; }
	.lfoot { display: flex; justify-content: space-between; margin-top: 8px; }

	/* switching project */
	.switch { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; background: var(--lc-surface-1); color: var(--lc-text-tertiary); font-size: 13px; animation: fadeIn var(--lc-motion) ease; }
	.switch[hidden] { display: none; }
	.switch img { width: 28px; }
	.bar { position: relative; width: 120px; height: 2px; overflow: hidden; border-radius: 2px; background: var(--lc-rule); }
	.bar i { position: absolute; top: 0; width: 40%; height: 100%; background: var(--lc-grad-brand); animation: slide 1.1s ease-in-out infinite; }
	@keyframes slide { 0% { left: -40%; } 100% { left: 100%; } }
</style>
</head>
<body>
	<div class="head"><img src="${media('logo.svg')}" alt="Lightchain"><span class="suffix">Studio</span></div>

	<div class="scroll" id="scroll">
		<button class="nav-item project" id="proj" aria-expanded="false"></button>
		<div class="menu" id="menu" hidden></div>

		<div class="group"><span class="group-title">Deployed</span><span class="note" id="net"></span><span class="grow"></span><button class="gear" id="searchBtn" title="Search contracts and tasks"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg></button></div>
		<div class="search" id="search" hidden><input class="input" id="q" placeholder="Search contracts and tasks"></div>
		<div class="list" id="programs"></div>

		<div class="group"><span class="group-title">Tasks</span><span class="note" id="taskCount"></span></div>
		<div class="list" id="tasks"></div>
		<div class="more" id="addRow">+ Add task</div>
		<form class="add" id="addForm" hidden><input class="input" id="addInput" placeholder="Task title, then Enter" maxlength="200"></form>
	</div>

	<div class="foot">
		<div class="group"><span class="group-title">Workspace</span></div>
		<div class="list" id="nav"></div>
		<div class="layout" id="layout" hidden>
			<div class="lrow"><span>AI chat</span><span class="seg" data-key="ai"><button data-v="aiRight">Right</button><button data-v="aiBottom">Bottom</button></span></div>
			<div class="lrow"><span>Terminal</span><span class="seg" data-key="terminal"><button data-v="terminalBottom">Bottom</button><button data-v="terminalRight">Right</button></span></div>
			<div class="lrow"><span>Contracts</span><span class="seg" data-key="contracts"><button data-v="contractsRight">Right</button><button data-v="contractsBottom">Bottom</button></span></div>
			<div class="lrow"><span>Show</span><span class="seg"><button data-t="left">Left</button><button data-t="bottom">Bottom</button><button data-t="rightSide">Right</button></span></div>
			<div class="lfoot"><span class="more" id="layoutReset" style="padding:0">Reset to default</span><span class="more" id="layoutClose" style="padding:0">Done</span></div>
		</div>
		<div class="menu up" id="wmenu" hidden></div>
		<div class="account" id="account"></div>
	</div>

	<div class="switch" id="switching" hidden><img src="${media('lightchain-tab.svg')}" alt=""><div class="bar"><i></i></div><div id="switchLabel">Opening…</div></div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	${IDENTICON_JS}
	let state = { project: null, recent: [], recentMine: false, wallets: [], chats: [], tasks: [], now: Date.now() };
	let query = '', showDone = false, showOther = false;
	const STATUS = { todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done' };
	const match = s => !query || s.toLowerCase().includes(query);
	const short = a => a.slice(0, 6) + '…' + a.slice(-4);
	const ICON = {
		chat: '<path d="M20 14a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
		todo: '<circle cx="12" cy="12" r="8"/>',
		doing: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
		review: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
		done: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
		files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
		search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
		agents: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
		board: '<rect x="3.5" y="4" width="4.5" height="16" rx="1"/><rect x="9.75" y="4" width="4.5" height="11" rx="1"/><rect x="16" y="4" width="4.5" height="7" rx="1"/>',
		map: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>',
		bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 20l3-2M19 20l-3-2"/>',
		chev: '<path d="m6 9 6 6 6-6"/>',
		layout: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M9.5 13h11"/>',
		gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
	};
	const svg = (d, cls) => '<svg class="' + (cls || 'nav-icon') + '" viewBox="0 0 24 24">' + d + '</svg>';
	function ago(t) { const s = Math.max(0, (state.now - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; }

	// a row: mark (identicon or icon) + name/sub, optional right side and hover actions
	function item(o) {
		const b = el('button', 'nav-item row' + (o.cls ? ' ' + o.cls : ''));
		if (o.mark) { const m = el('span', 'nav-mark'); m.innerHTML = o.mark; b.append(m); }
		else if (o.icon) { b.insertAdjacentHTML('beforeend', svg(ICON[o.icon])); }
		if (o.sub !== undefined) { const t = el('span', 'nav-body'); t.append(el('span', 'nav-name', o.name), el('span', 'nav-sub' + (o.mono ? ' mono' : ''), o.sub)); b.append(t); }
		else b.append(el('span', 'nav-label', o.name));
		if (o.state) b.append(el('span', 'state' + (o.acts ? ' hide' : ''), o.state));
		if (o.acts) { const a = el('span', 'row-acts'); o.acts.forEach(([l, fn, primary]) => { const x = el('span', 'button' + (primary ? ' button-primary' : '')); x.textContent = l; x.onclick = e => { e.stopPropagation(); fn(); }; a.append(x); }); b.append(a); }
		if (o.title) b.title = o.title;
		if (o.click) b.onclick = o.click;
		return b;
	}

	function renderProject() {
		const p = $('proj'); p.replaceChildren();
		const name = state.project ? state.project.name : 'No project';
		const m = el('span', 'nav-mark'); m.innerHTML = lcIdenticon(name); p.append(m);
		const t = el('span', 'nav-body'); t.append(el('span', 'nav-name', name), el('span', 'nav-sub', state.project ? 'Switch project' : 'Open or create a project'));
		p.append(t); p.insertAdjacentHTML('beforeend', svg(ICON.chev, 'nav-icon chev'));
		p.title = state.project ? state.project.path : '';
		const menu = $('menu'); menu.replaceChildren();
		const g = el('div', 'group'); g.append(el('span', 'group-title', state.recentMine ? 'Projects of this wallet' : 'Recent projects')); menu.append(g);
		if (!state.recent.length) menu.append(el('div', 'empty', state.account ? 'No other projects for this wallet yet.' : 'No other recent projects yet.'));
		state.recent.forEach(r => menu.append(item({ mark: lcIdenticon(r.label), name: r.label, sub: r.detail, click: () => switchTo(r) })));
		menu.append(el('div', 'sep'));
		menu.append(item({ icon: 'files', name: 'New project…', click: () => { menu.hidden = true; vscode.postMessage({ type: 'newProject' }); } }));
		menu.append(item({ icon: 'search', name: 'Open folder…', click: () => { menu.hidden = true; vscode.postMessage({ type: 'openFolder' }); } }));
	}
	function switchTo(r) {
		$('menu').hidden = true;
		$('switchLabel').textContent = 'Opening ' + r.label;
		$('switching').hidden = false;
		vscode.postMessage({ type: 'switch', uri: r.uri });
		setTimeout(() => { $('switching').hidden = true; }, 15000); // the window normally reloads long before
	}

	function renderPrograms() {
		const box = $('programs'); box.replaceChildren();
		const p = state.programs;
		$('net').textContent = p ? p.network : '';
		if (!p) { box.append(el('div', 'empty', 'Open a project to see its contracts.')); return; }
		const make = x => item({
			mark: lcIdenticon(x.address), name: x.name || short(x.address), sub: short(x.address), mono: true, title: x.address,
			acts: [['Call', () => vscode.postMessage({ type: 'program', action: 'call', address: x.address, name: x.name }), true], ['Scan', () => vscode.postMessage({ type: 'program', action: 'lightscan', address: x.address })]],
			click: () => vscode.postMessage({ type: 'program', action: 'call', address: x.address, name: x.name }),
		});
		const items = p.items.filter(x => match((x.name || '') + ' ' + x.address));
		if (!items.length && !query) {
			const e = el('div', 'empty', 'Nothing deployed yet. ');
			const d = el('span', 'more', 'Deploy a contract →'); d.style.padding = '0'; d.onclick = () => vscode.postMessage({ type: 'run', command: 'lightchain.deployContract' }); e.append(d); box.append(e);
		}
		items.forEach(x => box.append(make(x)));
		if (p.other.length) {
			const m = el('div', 'more', showOther ? 'Hide other deployments' : 'Other deployments (' + p.other.length + ')');
			m.onclick = () => { showOther = !showOther; renderPrograms(); }; box.append(m);
			if (showOther) p.other.filter(x => match((x.name || '') + ' ' + x.address)).forEach(x => box.append(make(x)));
		}
	}

	function renderTasks() {
		const box = $('tasks'); box.replaceChildren();
		const order = { doing: 0, review: 1, todo: 2, done: 3 };
		const list = state.tasks.filter(t => match(t.title + ' ' + t.key)).sort((a, b) => order[a.status] - order[b.status]);
		const open = list.filter(t => t.status !== 'done'), done = list.filter(t => t.status === 'done');
		$('taskCount').textContent = open.length ? String(open.length) : '';
		if (!list.length && !query) box.append(el('div', 'empty', 'Plan your project; let Lightchain AI do the tasks.'));
		(showDone ? list : open).forEach(t => box.append(item({
			icon: t.status, name: t.title, cls: 'task' + (t.status === 'done' ? ' done' : ''), state: t.priority === 'high' ? 'High' : '',
			title: t.key + ' · ' + STATUS[t.status],
			acts: [['Do with AI', () => vscode.postMessage({ type: 'aiTask', id: t.id }), true], ['Next', () => vscode.postMessage({ type: 'status', id: t.id })]],
			click: () => vscode.postMessage({ type: 'board', id: t.id }),
		})));
		if (done.length) { const m = el('div', 'more', showDone ? 'Hide done' : 'Done (' + done.length + ')'); m.onclick = () => { showDone = !showDone; renderTasks(); }; box.append(m); }
	}

	function renderFoot() {
		const nav = $('nav'); nav.replaceChildren();
		[['files', 'Files', 'workbench.view.explorer'], ['search', 'Search', 'workbench.view.search'], ['agents', 'Agents', 'lightchain.agents.open'], ['board', 'Task board', 'lightchain.tasks.board'], ['map', 'Contract map', 'lightchain.map.open'], ['bug', 'Debug a transaction', 'lightchain.tx.debug'], ['layout', 'Layout', '']]
			.forEach(([ic, label, command]) => { const b = item({ icon: ic, name: label, click: () => command ? vscode.postMessage({ type: 'run', command }) : toggleLayout() }); b.classList.remove('row'); b.classList.add('nav'); if (!command) b.id = 'layoutBtn'; nav.append(b); });
		const a = $('account'); a.replaceChildren();
		const acc = state.account;
		const m = el('span', 'nav-mark'); m.innerHTML = acc ? lcIdenticon(acc.address) : ''; a.append(m);
		const t = el('span', 'nav-body');
		const mine = (state.wallets || []).find(w => w.active);
		t.append(el('span', 'nav-name' + (mine ? '' : ' mono'), acc ? (mine ? mine.name : short(acc.address)) : 'Connect a wallet'), el('span', 'nav-sub', acc ? (mine ? short(acc.address) + ' · ' : '') + acc.network + (acc.credits ? ' · ' + acc.credits + ' credits' : '') : 'Needed for Lightchain AI and deploys'));
		a.append(t);
		const g = el('button', 'gear'); g.title = 'Settings'; g.innerHTML = svg(ICON.gear, ''); g.onclick = e => { e.stopPropagation(); vscode.postMessage({ type: 'run', command: 'workbench.action.openSettings' }); };
		a.append(g);
		// the account card switches wallets: each one has its own projects, agents, instructions and chats
		const wm = $('wmenu'); wm.replaceChildren();
		const wg = el('div', 'group'); wg.append(el('span', 'group-title', 'Wallets')); wm.append(wg);
		(state.wallets || []).forEach(w => {
			const b = item({ mark: lcIdenticon(w.address), name: w.name, sub: short(w.address), mono: true, click: () => { wm.hidden = true; if (!w.active) vscode.postMessage({ type: 'wallet', id: w.id }); } });
			if (w.active) b.append(el('span', 'tick', 'Active'));
			wm.append(b);
		});
		if ((state.wallets || []).length) wm.append(el('div', 'sep'));
		wm.append(item({ icon: 'agents', name: 'Add or manage wallets…', click: () => { wm.hidden = true; vscode.postMessage({ type: 'run', command: 'lightchain.wallet.menu' }); } }));
		a.title = (state.wallets || []).length > 1 ? 'Switch wallet: each has its own projects, agents and chats' : '';
		a.onclick = e => { e.stopPropagation(); if ((state.wallets || []).length) { wm.hidden = !wm.hidden; } else { vscode.postMessage({ type: 'run', command: 'lightchain.wallet.menu' }); } };
	}

	// layout: where the AI chat, terminal and contracts live; what is shown
	const layoutState = (() => { try { return Object.assign({ ai: 'aiRight', terminal: 'terminalBottom', contracts: 'contractsRight' }, (vscode.getState() || {}).layout); } catch { return { ai: 'aiRight', terminal: 'terminalBottom', contracts: 'contractsRight' }; } })();
	function toggleLayout() { const l = $('layout'); l.hidden = !l.hidden; paintLayout(); }
	function paintLayout() { document.querySelectorAll('.seg[data-key]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', layoutState[seg.dataset.key] === b.dataset.v))); }
	document.querySelectorAll('.seg[data-key] button').forEach(b => b.onclick = () => {
		const key = b.parentElement.dataset.key; layoutState[key] = b.dataset.v; paintLayout();
		try { vscode.setState(Object.assign(vscode.getState() || {}, { layout: layoutState })); } catch { }
		vscode.postMessage({ type: 'layout', action: b.dataset.v });
	});
	document.querySelectorAll('.seg button[data-t]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'layout', action: b.dataset.t }));
	$('layoutReset').onclick = () => { Object.assign(layoutState, { ai: 'aiRight', terminal: 'terminalBottom', contracts: 'contractsRight' }); paintLayout(); try { vscode.setState(Object.assign(vscode.getState() || {}, { layout: layoutState })); } catch { } vscode.postMessage({ type: 'layout', action: 'reset' }); };
	$('layoutClose').onclick = () => { $('layout').hidden = true; };

	function render() { renderProject(); renderPrograms(); renderTasks(); renderFoot(); }

	$('proj').onclick = e => { e.stopPropagation(); const m = $('menu'); m.style.top = ($('proj').offsetTop + $('proj').offsetHeight + 4 - $('scroll').scrollTop + $('scroll').offsetTop) + 'px'; m.hidden = !m.hidden; };
	document.addEventListener('click', e => { if (!$('menu').contains(e.target)) $('menu').hidden = true; if (!$('wmenu').contains(e.target)) $('wmenu').hidden = true; });
	document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('menu').hidden = true; $('addForm').hidden = true; $('addRow').hidden = false; } });
	$('searchBtn').onclick = () => { const s = $('search'); s.hidden = !s.hidden; if (!s.hidden) $('q').focus(); else { $('q').value = ''; query = ''; render(); } };
	$('q').addEventListener('input', () => { query = $('q').value.trim().toLowerCase(); renderPrograms(); renderTasks(); });
	$('addRow').onclick = () => { $('addRow').hidden = true; $('addForm').hidden = false; $('addInput').focus(); };
	$('addInput').addEventListener('blur', () => { if (!$('addInput').value.trim()) { $('addForm').hidden = true; $('addRow').hidden = false; } });
	$('addForm').onsubmit = e => { e.preventDefault(); const v = $('addInput').value.trim(); if (v) { vscode.postMessage({ type: 'addTask', title: v }); $('addInput').value = ''; } };
	window.addEventListener('message', e => { if (e.data && e.data.type === 'state') { state = e.data; render(); } });
	render();
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

export async function recentProjects(): Promise<{ label: string; detail: string; uri: string }[]> {
	try {
		const recent = await vscode.commands.executeCommand<{ workspaces?: Array<{ folderUri?: vscode.Uri; label?: string }> }>('_workbench.getRecentlyOpened');
		return (recent?.workspaces ?? [])
			.filter(w => w.folderUri)
			.slice(0, 8)
			.map(w => {
				const uri = vscode.Uri.from(w.folderUri!);
				return { label: w.label ?? path.basename(uri.fsPath), detail: uri.fsPath.replace(process.env.HOME ?? '\u0000', '~'), uri: uri.toString() };
			});
	} catch {
		return [];
	}
}
