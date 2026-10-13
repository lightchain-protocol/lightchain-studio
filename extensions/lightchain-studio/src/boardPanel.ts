import * as vscode from 'vscode';
import { STATUSES, Task, TaskPriority, TaskStatus, TaskStore } from './tasks';
import { siteCss } from './ui/site';

/** The project's task board in an editor tab: columns, drag and drop, card details, hand-off to Lightchain AI. */
export class BoardPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly tasks: TaskStore,
		private readonly runTask: (task: Task) => Promise<void>,
		private readonly plan: (goal: string) => Promise<void>,
	) {
		this.disposables.push(tasks.onDidChange(() => this.push()));
	}

	open(focusId?: string): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
		} else {
			this.panel = vscode.window.createWebviewPanel('lightchain.board', 'Board', vscode.ViewColumn.Active, {
				enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			});
			this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
			this.panel.webview.html = this.html(this.panel.webview);
			this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
		}
		this.push(focusId);
	}

	private push(focusId?: string): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		void this.panel?.webview.postMessage({
			type: 'state', project: folder?.name ?? null, prefix: this.tasks.prefix, focus: focusId,
			tasks: this.tasks.all, statuses: STATUSES,
		});
	}

	private async onMessage(m: any): Promise<void> {
		const status = (s: unknown): TaskStatus | undefined => STATUSES.some(x => x.id === s) ? s as TaskStatus : undefined;
		switch (m?.type) {
			case 'ready':
				return this.push();
			case 'add':
				if (!vscode.workspace.workspaceFolders?.length) {
					vscode.window.showWarningMessage('Open a project to keep tasks with it.');
					return;
				}
				if (typeof m.title === 'string' && m.title.trim()) {
					const t = await this.tasks.add({ title: m.title, status: status(m.status) });
					if (m.open) {
						this.push(t.id);
					}
				}
				return;
			case 'move':
				if (typeof m.id === 'string' && status(m.status)) {
					await this.tasks.move(m.id, status(m.status)!, typeof m.before === 'string' ? m.before : undefined);
				}
				return;
			case 'update': {
				const p = m.patch ?? {};
				await this.tasks.update(String(m.id), {
					...(typeof p.title === 'string' ? { title: p.title.slice(0, 200) } : {}),
					...(typeof p.description === 'string' ? { description: p.description.slice(0, 5000) } : {}),
					...(status(p.status) ? { status: status(p.status) } : {}),
					...(['low', 'medium', 'high'].includes(p.priority) ? { priority: p.priority as TaskPriority } : {}),
					...(Array.isArray(p.labels) ? { labels: p.labels.filter((l: unknown) => typeof l === 'string').slice(0, 6) } : {}),
				});
				return;
			}
			case 'delete': {
				const t = this.tasks.all.find(x => x.id === m.id);
				if (t && await vscode.window.showWarningMessage(`Delete ${this.tasks.prefix}-${t.key} “${t.title}”?`, { modal: true }, 'Delete') === 'Delete') {
					await this.tasks.remove(t.id);
				}
				return;
			}
			case 'ai': {
				const t = this.tasks.all.find(x => x.id === m.id);
				if (t) {
					await this.runTask(t);
				}
				return;
			}
			case 'plan': {
				const goal = await vscode.window.showInputBox({
					title: 'Plan with Lightchain AI',
					prompt: 'Describe what you want to build. Lightchain AI breaks it into tasks you can add to the board.',
					placeHolder: 'e.g. A raffle where people buy tickets in LCAI and a winner is drawn each week',
					ignoreFocusOut: true,
				});
				if (goal?.trim()) {
					await this.plan(goal.trim());
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	${siteCss(String(media('Inter-latin.woff2')))}
	html, body { height: 100%; }
	body { display: flex; flex-direction: column; overflow: hidden; }
	svg.i { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }

	.b-top { flex: none; display: flex; align-items: flex-end; gap: 12px; padding: 22px 28px 18px; border-bottom: 1px solid var(--line); }
	.b-top .eyebrow { margin-bottom: 10px; }
	.b-grow { flex: 1; }
	.b-filter { width: 220px; }

	.b-body { flex: 1; min-height: 0; display: flex; }
	.b-cols { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); overflow: auto; }
	.b-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
	.b-col:last-child { border-right: 0; }
	.b-col.over { background: rgba(255, 255, 255, 0.02); }
	.b-col__head { display: flex; align-items: center; gap: 8px; padding: 16px 16px 12px; }
	.b-col__head .n { color: var(--t4); }
	.b-cards { flex: 1; min-height: 40px; display: flex; flex-direction: column; gap: 10px; padding: 0 16px 12px; overflow-y: auto; }
	.b-card { padding: 14px 16px; cursor: grab; }
	.b-card:hover { border-color: rgba(204, 206, 239, 0.32); }
	.b-card.sel { border-color: var(--t3); }
	.b-card.dragging { opacity: .4; }
	.b-card__title { color: var(--t1); font-size: 13.5px; line-height: 1.45; word-break: break-word; }
	.b-card__meta { display: flex; align-items: center; gap: 10px; margin-top: 10px; color: var(--t4); font-size: 11px; }
	.b-card__meta .grow { flex: 1; }
	.b-pri { color: var(--t3); }
	.b-label { color: var(--t3); }
	.b-label::before { content: "#"; color: var(--t4); }
	.b-ai { color: var(--t3); }
	.b-quick { padding: 0 16px 16px; }
	.b-empty { padding: 24px 4px; color: var(--t4); font-size: 12px; }

	/* detail drawer */
	.b-detail { flex: none; width: 380px; display: flex; flex-direction: column; gap: 16px; padding: 22px 24px; border-left: 1px solid var(--line); overflow-y: auto; }
	.b-detail[hidden] { display: none; }
	.b-detail__key { display: flex; align-items: center; gap: 8px; }
	.b-detail__key .grow { flex: 1; }
	.b-detail input.title-input { width: 100%; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--t1); font-size: 18px; font-weight: 500; letter-spacing: -0.03em; outline: none; padding: 4px 0 10px; }
	.b-detail input.title-input:focus { border-bottom-color: var(--t4); }
	.b-field { display: flex; flex-direction: column; gap: 8px; }
	.b-field textarea { min-height: 150px; }
	.b-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.b-detail__actions { display: flex; gap: 8px; }
	.b-hint { color: var(--t4); font-size: 11.5px; line-height: 1.5; }
</style>
</head>
<body>
	<div class="b-top">
		<div><div class="eyebrow" id="eyebrow">Board</div><h1 class="title" id="title">Tasks</h1></div>
		<div class="b-grow"></div>
		<input class="field-input b-filter" id="filter" placeholder="Filter tasks">
		<button class="btn" id="planBtn" title="Describe a goal; Lightchain AI breaks it into tasks">Plan with AI</button>
		<button class="cta" id="newBtn">New task</button>
	</div>
	<div class="b-body">
		<div class="b-cols" id="cols"></div>
		<aside class="b-detail" id="detail" hidden></aside>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	let state = { tasks: [], statuses: [], prefix: 'LC', project: null };
	let selected = null, query = '', dragId = null;
	const PRI = { high: 'High', medium: 'Medium', low: 'Low' };

	function card(t) {
		const c = el('div', 'card b-card' + (t.id === selected ? ' sel' : ''));
		c.draggable = true; c.dataset.id = t.id;
		c.append(el('div', 'b-card__title', t.title));
		const meta = el('div', 'b-card__meta');
		meta.append(el('span', '', state.prefix + '-' + t.key));
		if (t.priority !== 'medium') meta.append(el('span', 'b-pri', PRI[t.priority]));
		(t.labels || []).slice(0, 2).forEach(l => meta.append(el('span', 'b-label', l)));
		meta.append(el('span', 'grow'));
		if (t.chat) { const a = el('span', 'b-ai', 'AI'); a.title = 'Lightchain AI worked on this'; meta.append(a); }
		c.append(meta);
		c.onclick = () => { selected = t.id; render(); };
		c.ondragstart = e => { dragId = t.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
		c.ondragend = () => { dragId = null; c.classList.remove('dragging'); document.querySelectorAll('.b-col').forEach(x => x.classList.remove('over')); };
		return c;
	}

	function render() { renderCols(); renderDetail(); }

	function renderCols() {
		$('eyebrow').textContent = state.project ? state.project : 'No project';
		$('title').textContent = 'Tasks';
		const cols = $('cols'); cols.replaceChildren();
		const visible = state.tasks.filter(t => !query || (t.title + ' ' + (t.description || '') + ' ' + state.prefix + '-' + t.key + ' ' + (t.labels || []).join(' ')).toLowerCase().includes(query));
		state.statuses.forEach(s => {
			const col = el('div', 'b-col'); col.dataset.status = s.id;
			const items = visible.filter(t => t.status === s.id);
			const head = el('div', 'b-col__head'); head.append(el('span', 'badge', s.label), el('span', 'badge n', String(items.length)));
			const list = el('div', 'b-cards');
			if (!items.length) list.append(el('div', 'b-empty', s.id === 'todo' && !state.tasks.length ? 'Add your first task below, or use Plan with AI.' : 'Drop tasks here'));
			items.forEach(t => list.append(card(t)));
			const quick = el('form', 'b-quick'); const qi = el('input', 'field-input'); qi.placeholder = 'Add to ' + s.label.toLowerCase(); qi.maxLength = 200; quick.append(qi);
			quick.onsubmit = e => { e.preventDefault(); const v = qi.value.trim(); if (v) { vscode.postMessage({ type: 'add', title: v, status: s.id }); qi.value = ''; } };
			col.append(head, list, quick);
			col.ondragover = e => { if (!dragId) return; e.preventDefault(); col.classList.add('over'); };
			col.ondragleave = e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); };
			col.ondrop = e => {
				e.preventDefault(); col.classList.remove('over');
				if (!dragId) return;
				// drop before the card under the pointer, else at the end of the column
				const after = [...list.querySelectorAll('.b-card')].find(x => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 && x.dataset.id !== dragId; });
				vscode.postMessage({ type: 'move', id: dragId, status: s.id, before: after ? after.dataset.id : undefined });
			};
			cols.append(col);
		});
	}

	function renderDetail() {
		const d = $('detail');
		const t = state.tasks.find(x => x.id === selected);
		if (!t) { d.hidden = true; return; }
		d.hidden = false; d.replaceChildren();
		const save = patch => vscode.postMessage({ type: 'update', id: t.id, patch });
		const top = el('div', 'b-detail__key'); top.append(el('span', 'badge', state.prefix + '-' + t.key), el('span', 'grow'));
		const x = el('button', 'link', 'Close'); x.title = 'Close'; x.onclick = () => { selected = null; render(); }; top.append(x);
		const title = el('input', 'title-input'); title.value = t.title; title.maxLength = 200;
		title.onchange = () => title.value.trim() && save({ title: title.value.trim() });
		const desc = el('div', 'b-field'); desc.append(el('label', 'badge', 'Description'));
		const ta = el('textarea', 'field-input'); ta.value = t.description || ''; ta.placeholder = 'What should be done? Acceptance criteria, links, notes…';
		ta.onchange = () => save({ description: ta.value }); desc.append(ta);
		const row = el('div', 'b-row');
		const sel = (label, value, options, key) => { const f = el('div', 'b-field'); f.append(el('label', 'badge', label)); const s = el('select', 'field-input'); options.forEach(([v, l]) => { const o = el('option', '', l); o.value = v; o.selected = v === value; s.append(o); }); s.onchange = () => save({ [key]: s.value }); f.append(s); return f; };
		row.append(sel('Status', t.status, state.statuses.map(s => [s.id, s.label]), 'status'), sel('Priority', t.priority, [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], 'priority'));
		const lf = el('div', 'b-field'); lf.append(el('label', 'badge', 'Labels'));
		const li = el('input', 'field-input'); li.value = (t.labels || []).join(', '); li.placeholder = 'contract, frontend, audit';
		li.onchange = () => save({ labels: li.value.split(',').map(s => s.trim()).filter(Boolean) }); lf.append(li);
		const actions = el('div', 'b-detail__actions');
		const ai = el('button', 'cta', 'Do with Lightchain AI'); ai.onclick = () => vscode.postMessage({ type: 'ai', id: t.id });
		const del = el('button', 'btn', 'Delete'); del.onclick = () => vscode.postMessage({ type: 'delete', id: t.id });
		actions.append(ai, del);
		const hint = el('div', 'b-hint', 'Lightchain AI gets the title and description, makes the changes, builds and tests them. The task moves to In progress.');
		d.append(top, title, desc, row, lf, actions, hint);
	}

	$('filter').addEventListener('input', () => { query = $('filter').value.trim().toLowerCase(); render(); });
	$('newBtn').onclick = () => { const i = document.querySelector('.b-col[data-status="todo"] .b-quick input'); if (i) i.focus(); };
	$('planBtn').onclick = () => vscode.postMessage({ type: 'plan' });
	document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { selected = null; render(); } });
	window.addEventListener('message', e => {
		const m = e.data;
		if (m && m.type === 'state') {
			const before = selected;
			state = m;
			if (m.focus) selected = m.focus;
			if (selected && !state.tasks.some(t => t.id === selected)) selected = null;
			// while typing in the drawer, refresh only the columns so the field keeps focus
			if (selected === before && $('detail').contains(document.activeElement)) renderCols();
			else render();
		}
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
