import * as vscode from 'vscode';
import * as os from 'node:os';
import { TEMPLATES } from './templates';
import { createProject, suggestName, templateFor } from './newProject';
import { siteCss } from './ui/site';

/**
 * New project, as a Lightchain modal (the lightchain.ai Buy & Bridge card)
 * instead of the command palette: describe the app or pick a template, name it,
 * watch it being created, and the window opens it.
 */
const ICONS: Record<string, string> = {
	counter: '<path d="M5 12h14M12 5v14"/>',
	token: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5h5v5h-5z"/>',
	nft: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.5"/><path d="m20 15-4.5-4.5L6 20"/>',
	coinflip: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16" opacity=".5"/>',
	escrow: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};

export class NewProjectPanel implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private parent = vscode.Uri.file(`${os.homedir()}/Lightchain Projects`);
	private busy = false;

	constructor(private readonly extensionUri: vscode.Uri) { }

	open(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		void vscode.commands.executeCommand('workbench.action.closePanel'); // the window gets the full height
		this.panel = vscode.window.createWebviewPanel('lightchain.newProject', 'New project', vscode.ViewColumn.Active, {
			enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		});
		this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'lightchain-tab.svg');
		this.panel.webview.html = this.html(this.panel.webview);
		this.panel.onDidDispose(() => { this.panel = undefined; });
		this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
	}

	private post(m: unknown): void {
		void this.panel?.webview.postMessage(m);
	}

	private async onMessage(m: any): Promise<void> {
		switch (m?.type) {
			case 'ready':
				this.post({ type: 'init', templates: TEMPLATES.map(t => ({ id: t.id, label: t.label, detail: t.detail, icon: ICONS[t.id] ?? ICONS.counter })), parent: this.display(this.parent) });
				return;
			case 'suggest':
				this.post({ type: 'suggest', name: suggestName(String(m.description ?? '')), template: templateFor(String(m.description ?? '')) });
				return;
			case 'folder': {
				const pick = await vscode.window.showOpenDialog({ title: 'Where should the project go?', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use This Folder', defaultUri: this.parent });
				if (pick?.[0]) {
					this.parent = pick[0];
					this.post({ type: 'parent', parent: this.display(this.parent) });
				}
				return;
			}
			case 'close':
				this.panel?.dispose();
				return;
			case 'create': {
				if (this.busy) {
					return;
				}
				const description = typeof m.description === 'string' && m.description.trim().length >= 8 ? m.description.trim() : undefined;
				const template = TEMPLATES.find(t => t.id === (m.template || (description ? templateFor(description) : 'counter'))) ?? TEMPLATES[0];
				this.busy = true;
				try {
					const root = await createProject({ template, name: String(m.name ?? ''), parent: this.parent, description }, step => this.post({ type: 'step', step }));
					this.post({ type: 'step', step: 'open' });
					await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
				} catch (err) {
					this.post({ type: 'error', message: (err as Error).message });
				} finally {
					this.busy = false;
				}
				return;
			}
		}
	}

	private display(uri: vscode.Uri): string {
		return uri.fsPath.replace(os.homedir(), '~');
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
	:root { --blackest: #0f1021; --zap: rgba(112, 100, 233, 0.18); --zap-strong: rgba(112, 100, 233, 0.45); --chip-edge: rgba(112, 100, 233, 0.24); }
	html, body { height: 100%; }
	body { display: grid; place-items: center; overflow-y: auto; padding: 32px 16px; background: radial-gradient(closest-side at 50% 45%, rgba(112, 48, 195, 0.22), rgba(65, 0, 147, 0.08) 55%, transparent 80%), var(--lc-surface-1); }
	h1, h2, p { margin: 0; }
	[hidden] { display: none !important; }

	/* aurora frame + card (.lc-bridge-menu-shell / .lc-bridge-menu) */
	@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
	.shell { --angle: 0deg; position: relative; isolation: isolate; border-radius: 20px; animation: cardIn .25s ease-out; }
	.shell::before, .shell::after { content: ""; position: absolute; border-radius: inherit; pointer-events: none; animation: spin 4.5s linear infinite; }
	.shell::before { inset: -2px; padding: 2px; z-index: 1; background: conic-gradient(from var(--angle), transparent 0deg, transparent 200deg, rgba(91, 75, 255, 0.35) 250deg, #5b4bff 290deg, #bc82f3 320deg, #dd00ac 340deg, transparent 360deg); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; }
	.shell::after { inset: -16px; z-index: -1; filter: blur(22px); opacity: .6; background: conic-gradient(from var(--angle), transparent 0deg, transparent 210deg, rgba(91, 75, 255, 0.55) 280deg, rgba(188, 130, 243, 0.6) 320deg, rgba(221, 0, 172, 0.5) 345deg, transparent 360deg); }
	@keyframes spin { to { --angle: 360deg; } }
	@keyframes cardIn { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: none; } }
	@media (prefers-reduced-motion: reduce) { .shell::before, .shell::after { animation: none; --angle: 300deg; } }
	.card { width: 620px; max-width: calc(100vw - 32px); padding: 18px; border-radius: 18px; background: var(--blackest); border: 1px solid var(--zap-strong); box-shadow: 0 0 0 1px rgba(91, 75, 255, 0.12), 0 24px 60px 8px rgba(0, 0, 0, 0.35); }
	.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 2px 2px 14px; margin-bottom: 14px; border-bottom: 1px solid var(--lc-rule); }
	.title { color: var(--lc-text-primary); font-size: 18px; font-weight: 600; line-height: 1.2; }
	.subtitle { margin-top: 4px; color: var(--lc-text-tertiary); font-size: 12.5px; }
	.close { flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--lc-text-tertiary); font-size: 18px; cursor: pointer; transition: all .2s ease; }
	.close:hover { background: var(--lc-surface-hover); color: var(--lc-text-primary); }
	.body { display: flex; flex-direction: column; gap: 12px; }

	/* .lc-zap__panel */
	.panel { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(204, 206, 239, 0.03); transition: border-color .2s ease; }
	.panel:focus-within { border-color: var(--zap-strong); }
	.label { margin-bottom: 8px; color: var(--lc-text-tertiary); font-size: 12px; font-weight: 500; }
	textarea.describe { width: 100%; min-height: 76px; padding: 0; border: 0; outline: none; resize: none; background: transparent; color: var(--lc-text-primary); font-family: inherit; font-size: 20px; font-weight: 500; line-height: 1.35; letter-spacing: -0.015em; }
	textarea.describe::placeholder { color: var(--lc-text-tertiary); opacity: .7; }
	.hint { margin-top: 8px; color: var(--lc-text-tertiary); font-size: 12px; }

	.or { display: flex; align-items: center; gap: 10px; color: var(--lc-text-tertiary); font-size: 12px; }
	.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--lc-rule); }
	/* template cards */
	.templates { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 8px; }
	.tpl { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(204, 206, 239, 0.03); color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease, transform .2s ease; }
	.tpl:hover { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.06); transform: translateY(-1px); }
	.tpl.sel { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.1); box-shadow: 0 0 0 1px rgba(91, 75, 255, 0.2) inset; }
	.tpl .ico { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--chip-edge); background: var(--lc-surface-hover); }
	.tpl svg { width: 15px; height: 15px; fill: none; stroke: #bc82f3; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	.tpl .n { font-size: 14px; font-weight: 600; }
	.tpl .d { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.tpl .tick { position: absolute; top: 10px; right: 10px; padding: 1px 8px; border-radius: 999px; background: rgba(221, 0, 172, 0.15); color: #ff6fdc; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; opacity: 0; transition: opacity .2s ease; }
	.tpl.sel .tick { opacity: 1; }

	/* details (name + location) */
	.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.field input { width: 100%; padding: 0; border: 0; outline: none; background: transparent; color: var(--lc-text-primary); font-family: Menlo, Monaco, "Courier New", monospace; font-size: 14px; }
	.loc { display: flex; align-items: center; gap: 8px; }
	.loc span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lc-text-primary); font-size: 13px; }
	.loc button { flex: none; padding: 1px 10px; border: 1px solid var(--chip-edge); border-radius: 999px; background: var(--lc-surface-hover); color: var(--lc-text-secondary); font-size: 11.5px; cursor: pointer; }
	.loc button:hover { border-color: var(--zap-strong); color: var(--lc-text-primary); }

	.notice { padding: 9px 14px; border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.1); color: #fecaca; font-size: 12.5px; }
	/* .lc-zap__submit */
	.submit { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 13px 16px; border: 0; border-radius: 12px; background: var(--lc-grad-brand); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; transition: filter .3s ease, box-shadow .3s ease; }
	.submit:hover:not(:disabled) { filter: brightness(1.2); box-shadow: 0 0 20px 5px rgba(112, 100, 233, 0.15); }
	.submit:disabled { opacity: .5; cursor: default; }
	.foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--lc-rule); color: var(--lc-text-tertiary); font-size: 12px; text-align: center; }

	/* progress */
	.steps { display: flex; flex-direction: column; }
	.step { display: flex; align-items: center; gap: 12px; padding: 11px 2px; color: var(--lc-text-secondary); font-size: 14px; }
	.step + .step { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.dot { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--zap-strong); color: var(--lc-text-tertiary); font-size: 11px; font-weight: 600; }
	.step.done { color: var(--lc-text-tertiary); }
	.step.done .dot { border-color: transparent; background: rgba(221, 0, 172, 0.15); box-shadow: inset 0 0 0 1px rgba(221, 0, 172, 0.4); color: #ff6fdc; }
	.step.now { color: var(--lc-text-strong); }
	.step.now .dot { border-color: var(--lc-accent); color: var(--lc-text-strong); box-shadow: 0 0 0 4px rgba(91, 75, 255, 0.15); }
	.spinner { width: 14px; height: 14px; margin-left: auto; border-radius: 50%; border: 2px solid rgba(204, 206, 239, 0.15); border-top-color: var(--lc-text-primary); animation: rot .8s linear infinite; }
	@keyframes rot { to { transform: rotate(360deg); } }
</style>
</head>
<body>
	<div class="shell"><div class="card">
		<div class="head">
			<div><div class="title" id="title">New project</div><div class="subtitle" id="subtitle">Describe your app in a sentence, or start from a template.</div></div>
			<button class="close" id="close" title="Close">×</button>
		</div>

		<div class="body" id="form">
			<div class="panel">
				<div class="label">What do you want to build?</div>
				<textarea class="describe" id="describe" maxlength="400" placeholder="A weekly raffle: people buy tickets in LCAI and one winner takes the pot"></textarea>
				<div class="hint" id="hint">Lightchain AI picks the closest starter and shapes it into your app.</div>
			</div>
			<div class="or">or start from a template</div>
			<div class="templates" id="templates"></div>
			<div class="row2">
				<div class="panel field"><div class="label">Project name</div><input id="name" value="my-lightchain-app" spellcheck="false" maxlength="60"></div>
				<div class="panel"><div class="label">Location</div><div class="loc"><span id="parent"></span><button id="folder">Change</button></div></div>
			</div>
			<div class="notice" id="error" hidden></div>
			<button class="submit" id="create">Create project</button>
		</div>

		<div class="body" id="progress" hidden>
			<div class="panel steps">
				<div class="step" data-step="files"><span class="dot">1</span><span>Creating your project</span></div>
				<div class="step" data-step="library"><span class="dot">2</span><span>Adding the contract library</span></div>
				<div class="step" data-step="open"><span class="dot">3</span><span>Opening it in Studio</span></div>
			</div>
		</div>
		<div class="foot" id="foot">Everything starts on testnet: free, safe to experiment.</div>
	</div></div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	let templates = [], picked = null, nameTouched = false, suggestTimer = null;
	const ORDER = ['files', 'library', 'open'];

	function renderTemplates() {
		const box = $('templates'); box.replaceChildren();
		templates.forEach(t => {
			const b = el('button', 'tpl' + (picked === t.id ? ' sel' : ''));
			const ico = el('span', 'ico'); ico.innerHTML = '<svg viewBox="0 0 24 24">' + t.icon + '</svg>';
			b.append(ico, el('span', 'n', t.label), el('span', 'd', t.detail), el('span', 'tick', picked === t.id && $('describe').value.trim().length >= 8 ? 'BEST MATCH' : 'SELECTED'));
			b.onclick = () => { picked = picked === t.id ? null : t.id; if (!nameTouched && picked) $('name').value = 'my-' + t.id; renderTemplates(); sync(); };
			box.append(b);
		});
	}
	function sync() {
		const d = $('describe').value.trim();
		$('create').textContent = d.length >= 8 ? 'Create and build with Lightchain AI' : picked ? 'Create from template' : 'Create project';
		$('create').disabled = d.length < 8 && !picked;
	}
	$('describe').addEventListener('input', () => {
		sync();
		clearTimeout(suggestTimer);
		suggestTimer = setTimeout(() => { const d = $('describe').value.trim(); if (d.length >= 8) vscode.postMessage({ type: 'suggest', description: d }); }, 350);
	});
	$('name').addEventListener('input', () => { nameTouched = true; });
	$('folder').onclick = () => vscode.postMessage({ type: 'folder' });
	$('close').onclick = () => vscode.postMessage({ type: 'close' });
	$('create').onclick = () => {
		$('error').hidden = true;
		vscode.postMessage({ type: 'create', description: $('describe').value, template: picked, name: $('name').value.trim() });
		$('form').hidden = true; $('progress').hidden = false;
		$('title').textContent = 'Creating ' + $('name').value.trim();
		$('subtitle').textContent = 'This takes a few seconds.';
		$('foot').textContent = 'Studio opens your project as soon as it is ready.';
	};
	document.addEventListener('keydown', e => { if (e.key === 'Escape') vscode.postMessage({ type: 'close' }); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('create').disabled && !$('form').hidden) $('create').click(); });
	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'init') { templates = m.templates; $('parent').textContent = m.parent; renderTemplates(); sync(); $('describe').focus(); }
		else if (m.type === 'parent') { $('parent').textContent = m.parent; }
		else if (m.type === 'suggest') { if (!nameTouched && m.name) $('name').value = m.name; picked = m.template; renderTemplates(); sync(); }
		else if (m.type === 'step') {
			const at = ORDER.indexOf(m.step);
			document.querySelectorAll('.step').forEach(s => {
				const i = ORDER.indexOf(s.dataset.step);
				s.className = 'step' + (i < at ? ' done' : i === at ? ' now' : '');
				s.querySelector('.dot').textContent = i < at ? '✓' : String(i + 1);
				s.querySelector('.spinner')?.remove();
				if (i === at) s.append(el('span', 'spinner'));
			});
		}
		else if (m.type === 'error') {
			$('progress').hidden = true; $('form').hidden = false;
			$('title').textContent = 'New project'; $('subtitle').textContent = 'Describe your app in a sentence, or start from a template.';
			$('error').textContent = m.message; $('error').hidden = false;
		}
	});
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
	}
}
