import * as vscode from 'vscode';
import { IDENTICON_JS, siteCss } from './site';

/**
 * A Lightchain page in an editor tab: the design system's styles, a header
 * (eyebrow, title, lead, actions) and a script that receives `state` messages.
 * Panels share this so every tab looks like the same product.
 */
export function page(webview: vscode.Webview, extensionUri: vscode.Uri, o: { title: string; lead: string; css?: string; script: string }): string {
	const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
	const font = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'Inter-latin.woff2'));
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	${siteCss(String(font))}
	html, body { height: 100%; overflow-x: hidden; }
	body { display: flex; flex-direction: column; animation: fadeIn var(--lc-motion) ease; }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	[hidden] { display: none !important; }
	:root { --zap: rgba(112, 100, 233, 0.18); --zap-strong: rgba(112, 100, 233, 0.45); }
	.p-top { flex: none; display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding: 24px 28px 18px; border-bottom: 1px solid var(--lc-rule); }
	.p-top .eyebrow { margin-bottom: 12px; }
	.p-top .title { color: var(--lc-text-strong); }
	.p-top .lead { margin-top: 6px; color: var(--lc-text-tertiary); font-size: 14px; }
	.p-top .grow { flex: 1; min-width: 0; }
	.p-actions { display: flex; gap: 8px; flex-wrap: wrap; }
	.p-body { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 28px 40px; }
	.p-col { display: flex; flex-direction: column; gap: 12px; max-width: 860px; }
	.zpanel { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(204, 206, 239, 0.03); }
	.zlabel { margin-bottom: 10px; color: var(--lc-text-tertiary); font-size: 12px; font-weight: 500; }
	.say { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(91, 75, 255, 0.06); color: var(--lc-text-primary); font-size: 14px; line-height: 1.6; }
	.say.bad { border-color: rgba(255, 42, 39, 0.35); background: rgba(255, 42, 39, 0.06); }
	.say.good { border-color: rgba(62, 183, 94, 0.35); background: rgba(62, 183, 94, 0.06); }
	.pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(112, 100, 233, 0.24); background: var(--lc-surface-hover); color: var(--lc-text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .04em; white-space: nowrap; }
	.pill.ok { border-color: transparent; background: rgba(62, 183, 94, 0.14); color: var(--lc-success); }
	.pill.err { border-color: transparent; background: rgba(255, 42, 39, 0.14); color: #ff6b69; }
	.pill.warn { border-color: transparent; background: rgba(255, 143, 60, 0.14); color: var(--lc-warning); }
	.pill.hot { border-color: transparent; background: rgba(221, 0, 172, 0.15); color: #ff6fdc; }
	.row { display: flex; align-items: baseline; gap: 12px; padding: 7px 0; font-size: 13px; }
	.row + .row { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.row .k { flex: none; width: 120px; color: var(--lc-text-tertiary); font-size: 12px; }
	.row .v { flex: 1; min-width: 0; color: var(--lc-text-primary); word-break: break-word; }
	.note { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.5; }
	.empty { margin: 60px auto; max-width: 420px; text-align: center; }
	.empty h2 { margin: 0 0 8px; color: var(--lc-text-strong); font-size: 18px; font-weight: 600; }
	.empty p { margin: 0 0 18px; color: var(--lc-text-tertiary); font-size: 13px; line-height: 1.6; }
	@media (max-width: 700px) { .p-top { padding: 18px 20px 14px; } .p-body { padding: 18px 20px 32px; } .row .k { width: 92px; } }
	${o.css ?? ''}
</style>
</head>
<body>
	<div class="p-top">
		<div class="grow"><div class="eyebrow">Lightchain</div><h1 class="title" id="title">${o.title}</h1><div class="lead" id="lead">${o.lead}</div></div>
		<div class="p-actions" id="actions"></div>
	</div>
	<div class="p-body" id="body"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	const btn = (label, primary, fn) => { const b = el('button', 'button button-sm' + (primary ? ' button-primary' : ''), label); b.type = 'button'; b.onclick = fn; return b; };
	const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
	const panel = (label) => { const p = el('div', 'zpanel'); if (label) p.append(el('div', 'zlabel', label)); return p; };
	const row = (k, v, mono) => { const r = el('div', 'row'); r.append(el('span', 'k', k), el('span', 'v' + (mono ? ' mono' : ''), v)); return r; };
	${o.script}
	post('ready');
</script>
</body>
</html>`;
}
