import * as vscode from 'vscode';
import { AgentProfile, AgentProfiles, BUILTIN_AGENTS, flow } from './agent/profiles';
import { IDENTICON_JS, siteCss } from './ui/site';

/**
 * Agent Studio: see how each Lightchain AI agent works (a visual flow of its
 * steps) and change it with plain controls — no code.
 */
export class AgentStudio implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private selected?: string;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly profiles: AgentProfiles,
		private readonly models: () => string[],
		private readonly use: (id: string, prompt?: string) => Promise<void>,
	) {
		this.disposables.push(profiles.onDidChange(() => this.push()));
	}

	open(id?: string): void {
		if (id) {
			this.selected = id;
		}
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
		} else {
			this.panel = vscode.window.createWebviewPanel('lightchain.agents', 'Agent Studio', vscode.ViewColumn.Active, {
				enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			});
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.webview.html = this.html(this.panel.webview);
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		}
		this.push();
	}

	/** A new agent (or a copy of `from`), opened for editing. */
	async create(from?: string): Promise<void> {
		const base = this.profiles.get(from ?? 'builder');
		const id = `agent-${Date.now().toString(36)}`;
		await this.profiles.put({ ...base, id, name: from ? `${base.name} copy` : 'New agent', glyph: from ? base.glyph : 'NA', builtin: undefined });
		this.open(id);
	}

	private push(): void {
		const agents = this.profiles.all.map(p => ({
			...p, flow: flow(p),
			kind: p.builtin ? 'builtin' : this.profiles.isCustomized(p.id) ? 'customized' : 'project',
		}));
		this.selected = agents.some(a => a.id === this.selected) ? this.selected : agents[0]?.id;
		void this.panel?.webview.postMessage({ type: 'state', agents, selected: this.selected, models: this.models(), hasProject: !!vscode.workspace.workspaceFolders?.length });
	}

	private async onMessage(m: any): Promise<void> {
		try {
			switch (m?.type) {
				case 'ready':
					return this.push();
				case 'select':
					this.selected = String(m.id);
					return this.push();
				case 'save':
					// editing a built-in saves a project copy with the same id
					await this.profiles.put(m.agent as AgentProfile);
					return;
				case 'create':
					return this.create(typeof m.from === 'string' ? m.from : undefined);
				case 'remove': {
					const p = this.profiles.get(String(m.id));
					const builtin = BUILTIN_AGENTS.some(b => b.id === p.id);
					const ok = await vscode.window.showWarningMessage(builtin ? `Reset ${p.name} to its default settings?` : `Delete the ${p.name} agent?`, { modal: true }, builtin ? 'Reset' : 'Delete');
					if (ok) {
						await this.profiles.remove(p.id);
					}
					return;
				}
				case 'use':
					return this.use(String(m.id), typeof m.prompt === 'string' ? m.prompt : undefined);
			}
		} catch (err) {
			vscode.window.showErrorMessage((err as Error).message);
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	${siteCss(String(media('Inter-latin.woff2')))}
	html, body { height: 100%; }
	body { display: flex; flex-direction: column; overflow: hidden; animation: fadeIn var(--lc-motion) ease; }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	.grow { flex: 1; }
	/* bridge-card language (LCAIPresale _bridge-menu.scss) */
	:root { --zap: rgba(112, 100, 233, 0.18); --zap-strong: rgba(112, 100, 233, 0.45); --chip-edge: rgba(112, 100, 233, 0.24); }
	.zpanel { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(204, 206, 239, 0.03); transition: border-color .2s ease; }
	.zpanel:focus-within { border-color: var(--zap-strong); }
	.zlabel { margin-bottom: 10px; color: var(--lc-text-tertiary); font-size: 12px; font-weight: 500; }
	.pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--chip-edge); background: var(--lc-surface-hover); color: var(--lc-text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
	.pill.on { border-color: transparent; background: rgba(221, 0, 172, 0.15); color: #ff6fdc; }
	.pill.off { color: var(--lc-text-tertiary); }

	/* header */
	.s-top { flex: none; display: flex; align-items: flex-end; gap: 16px; padding: 24px 28px 20px; border-bottom: 1px solid var(--lc-rule); }
	.s-top .eyebrow { margin-bottom: 12px; }
	.s-top .title { color: var(--lc-text-strong); }
	.s-top .lead { margin-top: 6px; color: var(--lc-text-tertiary); font-size: 14px; }
	.saved { color: var(--lc-text-tertiary); font-size: 12px; opacity: 0; transition: opacity .2s; }
	.saved.show { opacity: 1; }

	.s-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px minmax(340px, 1fr) 380px; }

	/* agents: P2P nav-items with identicons */
	.s-list { padding: 16px 10px; border-right: 1px solid var(--lc-rule); overflow-y: auto; }
	.s-list .group-title { display: block; padding: 0 6px 10px; }
	.s-card { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; margin-bottom: 2px; border: 0; border-radius: var(--lc-radius-sm); background: transparent; color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: all 400ms; }
	.s-card:hover, .s-card.sel { background: var(--lc-surface-2); color: var(--lc-accent); }
	.s-card.sel::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px; border-radius: 2px; background: var(--lc-accent); }
	.glyph { flex: none; width: 32px; height: 32px; border-radius: var(--lc-radius-sm); overflow: hidden; background: var(--lc-surface-3); display: grid; place-items: center; }
	.glyph svg { width: 100%; height: 100%; display: block; }
	.s-card__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.s-card__name { font-size: 14px; font-weight: 500; color: inherit; }
	.s-card__sum { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
	.s-card__kind { margin-top: 4px; }
	.s-new { margin: 12px 4px 0; width: calc(100% - 8px); }

	/* flow: bridge panels with step dots */
	.s-flow { padding: 26px 32px 40px; overflow-y: auto; }
	.s-flow__head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; max-width: 580px; }
	.s-flow__head .glyph { width: 48px; height: 48px; border-radius: 10px; }
	.s-flow__name { color: var(--lc-text-strong); font-size: 20px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
	.s-flow__role { margin-top: 4px; color: var(--lc-text-tertiary); font-size: 13px; line-height: 1.55; }
	.node { display: flex; align-items: center; gap: 14px; width: 100%; max-width: 580px; padding: 13px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(204, 206, 239, 0.03); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease, transform .2s ease; }
	.node:hover { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.06); transform: translateY(-1px); }
	.node.focus { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.08); }
	.node.off { background: transparent; border-style: dashed; }
	.node.off .node__text, .node.off .node__n { opacity: .5; }
	.node__n { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--zap-strong); color: var(--lc-text-strong); font-size: 11px; font-weight: 600; }
	.node:not(.off) .node__n { background: rgba(221, 0, 172, 0.15); border-color: rgba(221, 0, 172, 0.4); color: #ff6fdc; }
	.node__text { flex: 1; display: flex; flex-direction: column; min-width: 0; }
	.node__label { color: var(--lc-text-primary); font-size: 14px; font-weight: 500; line-height: 1.4; }
	.node__detail { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.link { display: block; width: 2px; height: 12px; margin-left: 27px; border-radius: 2px; background: linear-gradient(var(--zap-strong), var(--zap)); }
	.gate { max-width: 580px; margin: 0; padding: 9px 14px; border-radius: 12px; border: 1px solid var(--zap); background: rgba(91, 75, 255, 0.06); color: var(--lc-text-secondary); font-size: 12px; }
	.s-try { max-width: 580px; margin-top: 24px; }
	.chips { display: flex; flex-wrap: wrap; gap: 8px; }
	.tchip { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--chip-edge); background: var(--lc-surface-hover); color: var(--lc-text-primary); font-size: 13px; cursor: pointer; transition: border-color .2s ease; }
	.tchip:hover { border-color: var(--zap-strong); }

	/* settings: bridge panels with P2P inputs */
	.s-props { display: flex; flex-direction: column; gap: 12px; padding: 20px 22px 40px; border-left: 1px solid var(--lc-rule); overflow-y: auto; }
	.sec { scroll-margin-top: 10px; }
	.sec.flash { animation: flash 1s ease; }
	@keyframes flash { 0% { border-color: var(--lc-accent); } 100% { border-color: var(--zap); } }
	.sec p.help { margin: -4px 0 10px; color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.5; }
	.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
	.field:last-child { margin-bottom: 0; }
	.field label { color: var(--lc-text-secondary); font-size: 12px; }
	.input { height: 36px; font-size: 13px; }
	textarea.input { min-height: 110px; line-height: 1.55; }
	.rule { display: flex; gap: 6px; margin-bottom: 6px; }
	.rule input { flex: 1; }
	.x { flex: none; width: 36px; border: 2px solid var(--lc-rule); border-radius: var(--lc-radius-md); background: transparent; color: var(--lc-text-tertiary); cursor: pointer; transition: all .2s ease; }
	.x:hover { border-color: var(--lc-danger); color: var(--lc-danger); }
	.toggle { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; cursor: pointer; }
	.toggle + .toggle { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.toggle .check { margin-top: 1px; }
	.toggle__text { display: flex; flex-direction: column; }
	.toggle__title { color: var(--lc-text-primary); font-size: 13px; line-height: 1.4; }
	.toggle__help { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.note { margin-top: 8px; color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.5; }
	.manage { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>
	<div class="s-top">
		<div><div class="eyebrow">Lightchain AI</div><h1 class="title">Agent Studio</h1><div class="lead">See how each agent works and change it with switches and sentences. No code.</div></div>
		<div class="grow"></div>
		<span class="saved" id="saved">Saved</span>
		<button class="button button-primary button-sm" id="useBtn">Use in chat</button>
	</div>
	<div class="s-body">
		<div class="s-list" id="list"></div>
		<div class="s-flow" id="flow"></div>
		<div class="s-props" id="props"></div>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	let state = { agents: [], selected: null, models: [], hasProject: true };
	let draft = null, focusSec = null, saveTimer = null;

	const cur = () => state.agents.find(a => a.id === state.selected);
	function save() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const { flow, kind, ...agent } = draft;
			vscode.postMessage({ type: 'save', agent });
			$('saved').classList.add('show'); setTimeout(() => $('saved').classList.remove('show'), 1200);
		}, 350);
	}
	function change(fn) { fn(draft); renderFlow(); save(); }

	function renderList() {
		const box = $('list'); box.replaceChildren(el('span', 'group-title', 'Agents'));
		state.agents.forEach(a => {
			const c = el('button', 's-card' + (a.id === state.selected ? ' sel' : ''));
			const g = el('span', 'glyph'); g.innerHTML = lcIdenticon('agent:' + a.id);
			const t = el('span', 's-card__text'); t.append(el('span', 's-card__name', a.name), el('span', 's-card__sum', a.summary));
			const k = el('span', 's-card__kind'); k.append(el('span', 'pill', a.kind === 'builtin' ? 'Built-in' : a.kind === 'customized' ? 'Edited' : 'This project')); t.append(k);
			c.append(g, t);
			c.onclick = () => { if (a.id !== state.selected) { focusSec = null; vscode.postMessage({ type: 'select', id: a.id }); } };
			box.append(c);
		});
		const n = el('button', 'button button-sm button-block s-new', '+ New agent'); n.onclick = () => vscode.postMessage({ type: 'create' }); box.append(n);
	}

	function computeFlow(p) {
		return [
			{ id: 'understand', label: 'Understand', detail: 'Reads your request, the open file and the project map', on: true, sec: 'job' },
			{ id: 'read', label: 'Read code', detail: 'Opens and searches the project files it needs', on: p.can.read, sec: 'can' },
			{ id: 'plan', label: 'Plan', detail: 'Decides what to do, following its rules', on: true, sec: 'rules' },
			{ id: 'write', label: 'Change files', detail: p.can.write ? (p.approval === 'ask' ? 'Shows each change — you accept or reject' : 'Applies changes — you can undo them') : 'Not allowed: answers in the chat only', on: p.can.write, sec: 'safety' },
			{ id: 'build', label: 'Build', detail: p.can.build ? (p.check ? 'Compiles after every contract change and fixes errors' : 'Compiles when it needs to') : 'Not allowed', on: p.can.build, sec: 'checks' },
			{ id: 'test', label: 'Test', detail: p.can.test ? (p.check ? 'Runs the tests and fixes failures' : 'Runs tests when asked') : 'Not allowed', on: p.can.test, sec: 'checks' },
			{ id: 'answer', label: 'Summarise', detail: 'Tells you what it did and what to try next', on: true, sec: 'job' },
		];
	}

	function renderFlow() {
		const box = $('flow'); box.replaceChildren();
		const p = draft; if (!p) return;
		const head = el('div', 's-flow__head'); const g = el('span', 'glyph'); g.innerHTML = lcIdenticon('agent:' + p.id);
		const ht = el('div'); ht.append(el('div', 's-flow__name', p.name), el('div', 's-flow__role', p.role));
		head.append(g, ht); box.append(head);
		const steps = computeFlow(p);
		steps.forEach((s, i) => {
			if (i) box.append(el('div', 'link'));
			if (s.id === 'write' && s.on && p.approval === 'ask') { box.append(el('div', 'gate', 'You approve each change'), el('div', 'link')); }
			const n = el('button', 'node' + (s.on ? '' : ' off') + (focusSec === s.sec ? ' focus' : ''));
			n.append(el('span', 'node__n', String(i + 1)));
			const t = el('span', 'node__text'); t.append(el('span', 'node__label', s.label), el('span', 'node__detail', s.detail)); n.append(t);
			n.append(el('span', 'pill ' + (s.on ? 'on' : 'off'), s.on ? 'ON' : 'OFF'));
			n.title = 'Change this step';
			n.onclick = () => { focusSec = s.sec; renderFlow(); const sec = document.querySelector('[data-sec="' + s.sec + '"]'); if (sec) { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash'); } };
			box.append(n);
		});
		const tr = el('div', 's-try zpanel'); tr.append(el('div', 'zlabel', 'Try ' + p.name));
		const chips = el('div', 'chips');
		(p.starters.length ? p.starters : ['Explain this project']).forEach(sx => { const c = el('button', 'tchip', sx); c.onclick = () => vscode.postMessage({ type: 'use', id: p.id, prompt: sx }); chips.append(c); });
		tr.append(chips); box.append(tr);
	}

	function section(key, title, help) { const s = el('div', 'sec zpanel'); s.dataset.sec = key; s.append(el('div', 'zlabel', title)); if (help) s.append(el('p', 'help', help)); return s; }
	function toggle(title, help, on, fn) {
		const t = el('div', 'toggle' + (on ? ' on' : '')); t.append(el('span', 'check' + (on ? ' on' : ''), '✓'));
		const tx = el('span', 'toggle__text'); tx.append(el('span', 'toggle__title', title), el('span', 'toggle__help', help)); t.append(tx);
		t.onclick = () => { fn(); renderProps(); }; return t;
	}

	function renderProps() {
		const box = $('props'); const top = box.scrollTop; box.replaceChildren();
		const p = draft; if (!p) return;
		// identity
		const id = section('identity', 'About this agent');
		const fn = el('div', 'field'); fn.append(el('label', '', 'Name')); const ni = el('input', 'input'); ni.value = p.name; ni.maxLength = 40; ni.oninput = () => change(d => { d.name = ni.value || 'Agent'; }); fn.append(ni);
		const fs = el('div', 'field'); fs.append(el('label', '', 'Short description')); const si = el('input', 'input'); si.value = p.summary; si.maxLength = 120; si.oninput = () => change(d => { d.summary = si.value; }); fs.append(si);
		id.append(fn, fs);
		// job
		const job = section('job', 'Its job', 'Describe in plain words what this agent is for. It reads this before every request.');
		const ta = el('textarea', 'input'); ta.value = p.role; ta.maxLength = 2000; ta.oninput = () => change(d => { d.role = ta.value; }); job.append(ta);
		// rules
		const rules = section('rules', 'Rules it always follows', 'One sentence each, e.g. "Never use tx.origin."');
		p.rules.forEach((r, i) => {
			const rr = el('div', 'rule'); const ri = el('input', 'input'); ri.value = r; ri.maxLength = 200; ri.oninput = () => change(d => { d.rules[i] = ri.value; });
			const x = el('button', 'x', '×'); x.title = 'Remove rule'; x.onclick = () => { change(d => { d.rules.splice(i, 1); }); renderProps(); };
			rr.append(ri, x); rules.append(rr);
		});
		if (p.rules.length < 12) { const add = el('button', 'button button-xs', '+ Add rule'); add.onclick = () => { change(d => { d.rules.push(''); }); renderProps(); const ins = document.querySelectorAll('[data-sec="rules"] input'); ins[ins.length - 1]?.focus(); }; rules.append(add); }
		// permissions
		const can = section('can', 'What it may do', 'Switch off anything this agent should never touch.');
		const perm = (k, title, help) => can.append(toggle(title, help, p.can[k], () => change(d => { d.can[k] = !d.can[k]; })));
		perm('read', 'Read your code', 'Open and search files in the project');
		perm('write', 'Change files', 'Create and edit contracts, tests and scripts');
		perm('build', 'Build', 'Compile the contracts with Foundry');
		perm('test', 'Run tests', 'Run forge test and read the results');
		perm('run', 'Run terminal commands', 'Advanced — always asks you before each command');
		// safety
		const safety = section('safety', 'When it changes files');
		const radio = el('div', 'radio');
		radio.append(toggle('Ask me first', 'Each change shows in the file; you accept or reject it', p.approval === 'ask', () => change(d => { d.approval = 'ask'; })));
		radio.append(toggle('Apply automatically', 'Faster; every change can still be undone from the chat', p.approval === 'auto', () => change(d => { d.approval = 'auto'; })));
		safety.append(radio);
		if (!p.can.write) safety.append(el('div', 'note', 'This agent may not change files, so this does not apply.'));
		// checks
		const checks = section('checks', 'Checks');
		checks.append(toggle('Build and test after every change', 'Fixes compile errors and failing tests on its own (up to 2 rounds)', p.check, () => change(d => { d.check = !d.check; })));
		// model
		const model = section('model', 'Model');
		const ms = el('select', 'input'); const none = el('option', '', 'Same as the chat'); none.value = ''; ms.append(none);
		state.models.forEach(m => { const o = el('option', '', m); o.value = m; o.selected = m === p.model; ms.append(o); });
		ms.onchange = () => change(d => { d.model = ms.value || undefined; }); model.append(ms);
		// starters
		const st = section('starters', 'Example requests', 'Shown as one-click suggestions when you pick this agent.');
		[0, 1, 2].forEach(i => { const si2 = el('input', 'input'); si2.style.marginBottom = '6px'; si2.value = p.starters[i] || ''; si2.placeholder = 'e.g. Add a withdraw function'; si2.maxLength = 120; si2.oninput = () => change(d => { d.starters[i] = si2.value; d.starters = d.starters.map(s => s || '').slice(0, 3); }); st.append(si2); });
		// manage
		const mg = section('manage', 'Manage');
		const mrow = el('div', 'manage'); const dup = el('button', 'button button-xs', 'Duplicate'); dup.onclick = () => vscode.postMessage({ type: 'create', from: p.id });
		mrow.append(dup); mg.append(mrow);
		if (p.kind !== 'builtin') { const rm = el('button', 'button button-xs', p.kind === 'customized' ? 'Reset to default' : 'Delete agent'); rm.onclick = () => vscode.postMessage({ type: 'remove', id: p.id }); mrow.append(rm); }
		mg.append(el('div', 'note', p.kind === 'project' ? 'Saved in .lightchain/agents.json — shared with your team through git.' : 'Built-in agent. Your changes are saved for this project and can be reset.'));
		box.append(id, job, rules, can, safety, checks, model, st, mg);
		box.scrollTop = top;
	}

	$('useBtn').onclick = () => draft && vscode.postMessage({ type: 'use', id: draft.id });
	window.addEventListener('message', e => {
		const m = e.data; if (!m || m.type !== 'state') return;
		const switched = m.selected !== state.selected;
		state = m;
		const a = cur();
		// keep typing undisturbed: only rebuild the form when another agent is shown
		if (switched || !draft || !document.activeElement || !$('props').contains(document.activeElement)) {
			draft = a ? JSON.parse(JSON.stringify(a)) : null;
			if (draft) { draft.starters = draft.starters || []; }
			renderProps();
		}
		renderList(); renderFlow();
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
