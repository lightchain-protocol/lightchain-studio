import * as vscode from 'vscode';
import { NETWORKS } from './networks';

/**
 * Lightchain Studio start page (replaces the VS Code Welcome page).
 *
 * Built only from lightchain.ai components and copy, styled by the site's own
 * compiled SCSS (media/site-components.css, see fork-tools/start-page). The
 * site's viewport breakpoints are container queries on `.lc-start`, so the
 * page reflows like the site as the editor area resizes.
 */
const VIEW_TYPE = 'lightchain.start';

interface Recent { label: string; detail: string; uri: string }

export class StartPage implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly newProject: () => Promise<void>) { }

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Lightchain Studio', vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: false,
		});
		this.panel.iconPath = vscode.Uri.joinPath(media, 'lightchain.svg');
		this.panel.webview.html = this.html(this.panel.webview, await recentProjects());
		this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.disposables);
		this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
	}

	/** Show on startup when nothing else is open (replaces workbench.startupEditor). */
	maybeShowOnStartup(): void {
		const enabled = vscode.workspace.getConfiguration('lightchain.startPage').get<boolean>('showOnStartup', true);
		if (enabled && vscode.window.visibleTextEditors.length === 0 && vscode.window.tabGroups.all.every(g => g.tabs.length === 0)) {
			this.show();
		}
	}

	private async onMessage(msg: { type?: string; uri?: string; url?: string }): Promise<void> {
		switch (msg?.type) {
			case 'newProject':
				return this.newProject();
			case 'clone':
				await vscode.commands.executeCommand('git.clone');
				return;
			case 'openFolder':
				await vscode.commands.executeCommand('workbench.action.files.openFolder');
				return;
			case 'openRecent':
				if (msg.uri) {
					await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(msg.uri));
				}
				return;
			case 'external':
				if (msg.url && /^https:\/\//.test(msg.url)) {
					await vscode.env.openExternal(vscode.Uri.parse(msg.url));
				}
				return;
		}
	}

	private html(webview: vscode.Webview, recent: Recent[]): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const media = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', p));
		const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
		const arrow = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>';
		const icon = (d: string) => `<svg class="lc-row__icon" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
		const ext = '<svg class="lc-row__go" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
		const recentHtml = recent.length
			? recent.slice(0, 6).map(r => `<button class="lc-row" data-uri="${esc(r.uri)}">${icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}<span class="lc-row__text"><span class="lc-row__title">${esc(r.label)}</span><span class="lc-row__sub">${esc(r.detail)}</span></span></button>`).join('')
			: `<p class="lc-row lc-row--empty">No recent projects yet — create or open one.</p>`;

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('site-components.css')}">
<style nonce="${nonce}">
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin-ext.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
	/* site body (default/_typography.scss): Inter 16px, #7376aa on #070710 */
	html, body { margin: 0; padding: 0; background: #070710; }
	body { font-family: "Inter", sans-serif; font-size: 16px; line-height: 1.7; color: #7376aa; -webkit-font-smoothing: antialiased; }
	*, *::before, *::after { box-sizing: border-box; }
	h1, h2, h3, h4, p { margin: 0; }
	button { font-family: inherit; }
	/* Bootstrap utilities the site markup relies on (bootstrap 5 definitions) */
	.d-flex { display: flex !important; }
	.align-items-center { align-items: center !important; }
	.m-0 { margin: 0 !important; }
	.text-start { text-align: left !important; }
	.text-uppercase { text-transform: uppercase !important; }

	/* the site's viewport breakpoints resolve against this element */
	.lc-start { container: page / inline-size; min-height: 100vh; }

	/* header.lightchain-header: 80px, hairline bottom; logo 176x35 */
	.lc-start__header { display: flex; align-items: center; height: 81px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
	.lc-start__header img { display: block; width: 176px; max-width: 100%; height: auto; }

	.btn-default, .ecosystem-section__button { cursor: pointer; }
	/* The site positions card wrappers absolutely inside its GSAP scroll-stack (pin-spacer
	   + stack provide the height). The start page has no scroll animation, so the card
	   sits in normal flow; every visual rule is still the site's. */
	.lc-start .ecosystem-section__card-wrapper { position: relative; top: auto; }
	/* the site spaces page sections 120px apart; inside the IDE the blocks below use 40px */
	.lc-start .ecosystem-section { padding-top: 40px; padding-bottom: 0; }

	/* Start / Recent / Resources: site tokens (cards #070710 + hairline borders, Inter, #f5f6ff / #7376aa) in a compact IDE layout */
	.lc-start__block { padding: 40px 0 0; }
	.lc-start__block:last-child { padding-bottom: 72px; }
	.lc-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 32px; }
	@container page (max-width: 760px) { .lc-cols { grid-template-columns: 1fr; } }
	.lc-list { margin-top: 16px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #070710; overflow: hidden; }
	.lc-row { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 16px; border: 0; border-top: 1px solid rgba(255, 255, 255, 0.06); background: transparent; text-align: left; color: #ccceef; font-size: 16px; cursor: pointer; transition: background-color .15s; }
	.lc-row:first-child { border-top: 0; }
	.lc-row:hover { background: rgba(204, 206, 239, 0.04); }
	.lc-row--empty { margin: 0; cursor: default; color: #7376aa; font-size: 14px; }
	.lc-row--empty:hover { background: transparent; }
	.lc-row__icon { flex: none; width: 20px; height: 20px; fill: none; stroke: #b1b3d0; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
	.lc-row__text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
	.lc-row__title { color: #f5f6ff; font-weight: 500; }
	.lc-row__sub { color: #7376aa; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-row__key { margin-left: auto; flex: none; color: #7376aa; font-size: 13px; }
	.lc-row__go { margin-left: auto; flex: none; width: 18px; height: 18px; fill: none; stroke: #7376aa; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform .15s, stroke .15s; }
	.lc-row:hover .lc-row__go { stroke: #f5f6ff; transform: translate(2px, -2px); }
	.lc-res { margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
	.lc-res .lc-row { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #070710; align-items: flex-start; }
	.lc-res .lc-row:hover { border-color: rgba(255, 255, 255, 0.2); }
	.lc-res .lc-row__sub { white-space: normal; }
</style>
</head>
<body>
<main class="lc-start">
	<div class="lc-home-container">
		<header class="lc-start__header"><img src="${media('logo.svg')}" alt="Lightchain AI"></header>
	</div>

	<section class="ecosystem-section lc-home-container">
		<div class="lc-home-container">
			<div class="ecosystem-section__card-wrapper">
				<div class="scroll-stack__card-shell ecosystem-section__card--ide">
					<article class="ecosystem-section__card ecosystem-section__card--ide">
						<div class="ecosystem-section__card-copy">
							<div class="ecosystem-section__card-heading">
								<h3 class="ecosystem-section__card-title ecosystem-section__card-title--split"><span>Lightchain</span><span>IDE</span></h3>
								<p class="ecosystem-section__badge">BUILD ON LIGHTCHAIN</p>
							</div>
							<div class="ecosystem-section__card-bottom">
								<p class="ecosystem-section__card-description">A developer workspace for writing, testing, and deploying applications built around Lightchain’s AI-native blockchain infrastructure.</p>
								<button class="ecosystem-section__button" data-action="newProject"><span>New Project</span>${arrow}</button>
							</div>
						</div>
						<div class="ecosystem-section__image-area ecosystem-section__image-area--ide">
							<img alt="Lightchain IDE workspace" class="ecosystem-section__card-image" src="${media('ecosystem/ide.png')}">
						</div>
					</article>
				</div>
			</div>
		</div>
	</section>

	<div class="lc-home-container">
		<div class="lc-start__block lc-cols">
			<div>
				<h4 class="lc-sm-title border-left m-0">Start &gt;&gt;</h4>
				<div class="lc-list">
					<button class="lc-row" data-action="newProject">${icon('<path d="M12 5v14"/><path d="M5 12h14"/>')}<span class="lc-row__text"><span class="lc-row__title">New Project</span><span class="lc-row__sub">Foundry contract, test and deploy script</span></span></button>
					<button class="lc-row" data-action="openFolder">${icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}<span class="lc-row__text"><span class="lc-row__title">Open Folder</span><span class="lc-row__sub">Work on an existing project</span></span></button>
					<button class="lc-row" data-action="clone">${icon('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/>')}<span class="lc-row__text"><span class="lc-row__title">Clone Repository</span><span class="lc-row__sub">From GitHub or any Git URL</span></span></button>
				</div>
			</div>
			<div>
				<h4 class="lc-sm-title border-left m-0">Recent &gt;&gt;</h4>
				<div class="lc-list">${recentHtml}</div>
			</div>
		</div>
		<div class="lc-start__block">
			<h4 class="lc-sm-title border-left m-0">Resources &gt;&gt;</h4>
			<div class="lc-res">
				<button class="lc-row" data-url="https://lightfaucet.ai"><span class="lc-row__text"><span class="lc-row__title">Testnet Faucet</span><span class="lc-row__sub">Claim free test LCAI for gas and Lightchain AI credits.</span></span>${ext}</button>
				<button class="lc-row" data-url="${NETWORKS.testnet.explorerUrl}"><span class="lc-row__text"><span class="lc-row__title">Lightscan</span><span class="lc-row__sub">Browse blocks, transactions and deployed contracts.</span></span>${ext}</button>
				<button class="lc-row" data-url="https://docs.lightchain.ai"><span class="lc-row__text"><span class="lc-row__title">Documentation</span><span class="lc-row__sub">Learn the AIVM and how to build on Lightchain.</span></span>${ext}</button>
			</div>
		</div>
	</div>
</main>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', e => {
		const el = e.target.closest('[data-action],[data-url],[data-uri]');
		if (!el) return;
		if (el.dataset.action) vscode.postMessage({ type: el.dataset.action });
		else if (el.dataset.url) vscode.postMessage({ type: 'external', url: el.dataset.url });
		else if (el.dataset.uri) vscode.postMessage({ type: 'openRecent', uri: el.dataset.uri });
	});
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

async function recentProjects(): Promise<Recent[]> {
	try {
		// Internal workbench command (stable since 2018); returns recently opened folders/workspaces.
		const recent = await vscode.commands.executeCommand<{ workspaces?: Array<{ folderUri?: vscode.Uri; label?: string }> }>('_workbench.getRecentlyOpened');
		return (recent?.workspaces ?? [])
			.filter(w => w.folderUri)
			.slice(0, 6)
			.map(w => {
				const uri = vscode.Uri.from(w.folderUri!);
				const path = uri.fsPath;
				return { label: w.label ?? path.split(/[\\/]/).pop() ?? path, detail: path, uri: uri.toString() };
			});
	} catch {
		return [];
	}
}
