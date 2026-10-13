import * as vscode from 'vscode';
import { AGENTS_DIR, AgentProfile, AgentProfiles, BUILTIN_AGENTS, flow } from './agent/profiles';
import { RULES_BUDGET, RULES_DIR, Rule, RuleStore, renderRules } from './agent/rules';
import { WorkspaceIndex } from './agent/workspaceIndex';
import { estimateTokens } from './agent/memory';
import { IDENTICON_JS, siteCss } from './ui/site';

type Tab = 'agents' | 'rules' | 'context';

/**
 * Agent Studio: what Lightchain AI is and knows in this project, in one tab.
 *
 *   Agents        how each agent works (a visual flow) and what it may do
 *   Instructions  what every agent must keep in mind — Markdown files in the project
 *   Project context  what Lightchain AI knows about the code, found on this machine
 *
 * Everything is stored as Markdown in .lightchain/, so it can also be written
 * by hand and is shared with the team through git.
 */
export class AgentStudio implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private selected?: string;
	private selectedRule?: string;
	private tab: Tab = 'agents';
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly profiles: AgentProfiles,
		private readonly rules: RuleStore,
		private readonly index: WorkspaceIndex,
		private readonly models: () => string[],
		private readonly use: (id: string, prompt?: string) => Promise<void>,
		private readonly projectMap: () => Promise<string>,
	) {
		this.disposables.push(profiles.onDidChange(() => this.push()), rules.onDidChange(() => this.push()));
	}

	open(id?: string, tab?: Tab, ruleId?: string): void {
		if (id) {
			this.selected = id;
			this.tab = 'agents';
		}
		if (tab) {
			this.tab = tab;
		}
		if (ruleId) {
			this.selectedRule = ruleId;
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
		const name = from ? `${base.name} copy` : 'New agent';
		const id = this.profiles.newId(name);
		const blank = { summary: '', role: '', rules: [], starters: [], glyph: 'NA' };
		await this.profiles.put({ ...base, ...(from ? {} : blank), id, name, builtin: undefined });
		this.open(id);
	}

	/** A new instruction file, opened for writing. */
	async createRule(): Promise<void> {
		const rule = await this.rules.create();
		this.open(undefined, 'rules', rule.id);
	}

	private relFile(id: string): string {
		return `${AGENTS_DIR}/${id}.md`;
	}

	private push(): void {
		const agents = this.profiles.all.map(p => ({
			...p, flow: flow(p), file: this.relFile(p.id),
			kind: p.builtin ? 'builtin' : this.profiles.isCustomized(p.id) ? 'customized' : 'project',
		}));
		this.selected = agents.some(a => a.id === this.selected) ? this.selected : agents[0]?.id;
		const all = this.rules.all;
		this.selectedRule = all.some(r => r.id === this.selectedRule) ? this.selectedRule : all[0]?.id;
		const sent = renderRules(this.rules.always());
		const rules = all.map(r => {
			const part = sent.parts.find(x => x.id === r.id);
			return { ...r, chars: r.body.trim().length, cut: !!part?.cut, left: r.apply === 'always' && !part && !!r.body.trim() };
		});
		void this.panel?.webview.postMessage({
			type: 'state', tab: this.tab, agents, selected: this.selected, models: this.models(), hasProject: !!vscode.workspace.workspaceFolders?.length,
			rules, selectedRule: this.selectedRule, budget: RULES_BUDGET, used: sent.text.length, rulesDir: RULES_DIR,
		});
	}

	/** What the Project context tab shows: the local index and what every conversation starts with. */
	private async pushContext(force = false): Promise<void> {
		await this.index.refresh(force).catch(() => undefined);
		const map = await this.projectMap().catch(() => '');
		const window = vscode.workspace.getConfiguration('lightchain.ai').get<number>('contextTokens', 8_192);
		void this.panel?.webview.postMessage({ type: 'context', files: this.index.index.files, chunks: this.index.index.chunks, enabled: this.index.enabled, map, mapTokens: estimateTokens(map), window });
	}

	private async reveal(rel: string, line?: number): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, rel));
		const at = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: at });
	}

	private async onMessage(m: any): Promise<void> {
		try {
			switch (m?.type) {
				case 'ready':
					return this.push();
				case 'tab':
					this.tab = m.tab === 'rules' || m.tab === 'context' ? m.tab : 'agents';
					this.push();
					return this.tab === 'context' ? this.pushContext() : undefined;
				case 'selectRule':
					this.selectedRule = String(m.id);
					return this.push();
				case 'createRule':
					return this.createRule();
				case 'saveRule':
					await this.rules.put(m.rule as Rule);
					return;
				case 'removeRule': {
					const r = this.rules.get(String(m.id));
					if (r && await vscode.window.showWarningMessage(`Delete the instruction "${r.title}"?`, { modal: true, detail: `${r.file} is removed from the project.` }, 'Delete')) {
						await this.rules.remove(r.id);
					}
					return;
				}
				case 'openRule': {
					const r = this.rules.get(String(m.id));
					return r ? this.reveal(r.file) : undefined;
				}
				case 'openAgent': {
					// a built-in has no file until it is saved for this project
					const p = this.profiles.get(String(m.id));
					if (p.builtin) {
						await this.profiles.put(p);
					}
					return this.reveal(this.relFile(p.id));
				}
				case 'openFile':
					return this.reveal(String(m.path), typeof m.line === 'number' ? m.line : undefined);
				case 'refreshContext':
					return this.pushContext(true);
				case 'localContext':
					await vscode.workspace.getConfiguration('lightchain.ai').update('localContext', !!m.on, vscode.ConfigurationTarget.Global);
					return this.pushContext();
				case 'search': {
					const hits = await this.index.search(String(m.query ?? ''), [], { maxChunks: 6, maxChars: 6_000 });
					void this.panel?.webview.postMessage({ type: 'hits', query: String(m.query ?? ''), hits: hits.map(h => ({ path: h.path, start: h.start, end: h.end, label: h.label, preview: h.text.split('\n').filter(l => l.trim()).slice(0, 4).join('\n') })) });
					return;
				}
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
	html, body { height: 100%; overflow-x: hidden; }
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
	[hidden] { display: none !important; }
	.s-top { flex: none; display: flex; align-items: flex-end; gap: 16px; padding: 24px 28px 16px; }
	/* tabs: quiet text, accent underline for the open one */
	.s-tabs { flex: none; display: flex; gap: 22px; padding: 0 28px; border-bottom: 1px solid var(--lc-rule); }
	.s-tab { display: inline-flex; align-items: center; gap: 8px; padding: 10px 0 11px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--lc-text-tertiary); font-size: 13px; font-weight: 500; cursor: pointer; transition: color var(--lc-motion) ease, border-color var(--lc-motion) ease; }
	.s-tab:hover { color: var(--lc-text-primary); }
	.s-tab.on { color: var(--lc-text-strong); border-bottom-color: var(--lc-accent); }
	.s-tab .n { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--lc-surface-3); color: var(--lc-text-secondary); font-size: 11px; line-height: 18px; text-align: center; }
	.s-top .eyebrow { margin-bottom: 12px; }
	.s-top .title { color: var(--lc-text-strong); }
	.s-top .lead { margin-top: 6px; color: var(--lc-text-tertiary); font-size: 14px; }
	.saved { color: var(--lc-text-tertiary); font-size: 12px; opacity: 0; transition: opacity .2s; }
	.saved.show { opacity: 1; }

	.s-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) minmax(300px, 380px); }
	.s-body > *, .c-body > * { min-width: 0; }

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
	.path { display: block; margin-bottom: 10px; color: var(--lc-text-secondary); font-size: 12px; word-break: break-all; }

	/* instructions: list, editor, what the AI receives */
	.pill.warn { border-color: transparent; background: rgba(255, 143, 60, 0.14); color: var(--lc-warning); }
	.r-edit { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 22px 28px 24px; overflow-y: auto; }
	.r-edit > *, .c-main > * { width: 100%; max-width: 760px; }
	.r-title { height: 44px !important; font-size: 18px !important; font-weight: 600; color: var(--lc-text-strong) !important; }
	.r-body { flex: 1; display: flex; flex-direction: column; min-height: 260px; }
	.r-body textarea { flex: 1; min-height: 220px; resize: none; font-size: 13.5px; line-height: 1.65; }
	.r-foot { display: flex; gap: 12px; margin-top: 8px; color: var(--lc-text-tertiary); font-size: 12px; }
	.r-globs { margin: 2px 0 8px 30px; width: calc(100% - 30px); }
	.empty { margin: auto; max-width: 420px; text-align: center; }
	.empty h2 { margin: 0 0 8px; color: var(--lc-text-strong); font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
	.empty p { margin: 0 0 18px; color: var(--lc-text-tertiary); font-size: 13px; line-height: 1.6; }
	.meter { height: 6px; margin: 4px 0 8px; border-radius: 999px; background: var(--lc-surface-3); overflow: hidden; }
	.meter i { display: block; height: 100%; border-radius: 999px; background: var(--lc-accent); transition: width var(--lc-motion-base) ease; }
	.meter.over i { background: var(--lc-warning); }
	.meter-text { color: var(--lc-text-secondary); font-size: 12px; }
	.row { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--lc-text-primary); font-size: 13px; }
	.row + .row { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.row .grow { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row .num { color: var(--lc-text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }

	/* project context */
	.c-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 460px); }
	.c-main { display: flex; flex-direction: column; gap: 12px; padding: 22px 28px 40px; overflow-y: auto; }
	.c-lead { margin: 0 0 12px; color: var(--lc-text-tertiary); font-size: 13px; line-height: 1.6; }
	.stats { display: flex; gap: 28px; margin-bottom: 4px; }
	.stat b { display: block; color: var(--lc-text-strong); font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; font-variant-numeric: tabular-nums; }
	.stat span { color: var(--lc-text-tertiary); font-size: 12px; }
	.hit { display: block; width: 100%; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--zap); border-radius: 12px; background: transparent; color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease; }
	.hit:hover { border-color: var(--zap-strong); background: rgba(91, 75, 255, 0.06); }
	.hit__head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
	.hit__head .where { color: var(--lc-text-tertiary); font-size: 12px; }
	.hit pre, .map { margin: 6px 0 0; color: var(--lc-text-tertiary); font-family: Menlo, Monaco, "Courier New", monospace; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow: hidden; }
	.map { max-height: none; color: var(--lc-text-secondary); }

	/* a narrow tab (both side bars open): the settings move under the main column and the page scrolls as one */
	@media (max-width: 1000px) {
		.s-top { padding: 18px 20px 12px; flex-wrap: wrap; }
		.s-tabs { padding: 0 20px; }
		.s-body { grid-template-columns: 200px minmax(0, 1fr); grid-auto-rows: min-content; align-content: start; overflow-y: auto; }
		.s-body > .s-list { grid-row: 1 / span 2; overflow: visible; }
		.s-body > .s-flow, .s-body > .r-edit, .s-body > .s-props { grid-column: 2; overflow: visible; }
		.s-body > .s-flow { padding: 20px 20px 8px; }
		.s-body > .r-edit { padding: 18px 20px 8px; }
		.s-body > .s-props { border-left: 0; padding: 12px 20px 40px; }
		.r-body { min-height: 300px; }
		.c-body { grid-template-columns: minmax(0, 1fr); grid-auto-rows: min-content; align-content: start; overflow-y: auto; }
		.c-body > * { overflow: visible; }
		.c-main { padding: 18px 20px 8px; }
		.c-body > .s-props { border-left: 0; padding: 12px 20px 40px; }
	}
	@media (max-width: 640px) {
		.s-body { grid-template-columns: minmax(0, 1fr); }
		.s-body > .s-list { grid-row: auto; border-right: 0; border-bottom: 1px solid var(--lc-rule); }
		.s-body > .s-flow, .s-body > .r-edit, .s-body > .s-props { grid-column: 1; }
	}
</style>
</head>
<body>
	<div class="s-top">
		<div><div class="eyebrow">Lightchain AI</div><h1 class="title">Agent Studio</h1><div class="lead" id="lead"></div></div>
		<div class="grow"></div>
		<span class="saved" id="saved">Saved</span>
		<button class="button button-primary button-sm" id="useBtn">Use in chat</button>
	</div>
	<div class="s-tabs" id="tabs"></div>
	<div class="s-body" id="tab-agents">
		<div class="s-list" id="list"></div>
		<div class="s-flow" id="flow"></div>
		<div class="s-props" id="props"></div>
	</div>
	<div class="s-body" id="tab-rules" hidden>
		<div class="s-list" id="rlist"></div>
		<div class="r-edit" id="redit"></div>
		<div class="s-props" id="rside"></div>
	</div>
	<div class="c-body" id="tab-context" hidden>
		<div class="c-main" id="cmain"></div>
		<div class="s-props" id="cside"></div>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	let state = { tab: 'agents', agents: [], selected: null, models: [], hasProject: true, rules: [], selectedRule: null, budget: 2400, used: 0, rulesDir: '' };
	let draft = null, focusSec = null, saveTimer = null;
	let ruleDraft = null, ruleTimer = null;
	let context = null, hits = null, query = '', searchTimer = null;
	const LEADS = {
		agents: 'See how each agent works and change it with switches and sentences. No code.',
		rules: 'What every agent keeps in mind in this project. Plain Markdown files your team shares through git.',
		context: 'What Lightchain AI knows about your code. Found on this machine, never uploaded.',
	};
	const flashSaved = () => { $('saved').classList.add('show'); setTimeout(() => $('saved').classList.remove('show'), 1200); };
	const num = n => String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');

	function renderTabs() {
		const tabs = [['agents', 'Agents', state.agents.length], ['rules', 'Instructions', state.rules.length], ['context', 'Project context', null]];
		$('tabs').replaceChildren(...tabs.map(([id, label, n]) => {
			const b = el('button', 's-tab' + (state.tab === id ? ' on' : ''), label);
			if (n !== null) b.append(el('span', 'n', String(n)));
			b.onclick = () => { if (state.tab !== id) { state.tab = id; showTab(); vscode.postMessage({ type: 'tab', tab: id }); } };
			return b;
		}));
	}
	function showTab() {
		['agents', 'rules', 'context'].forEach(t => { $('tab-' + t).hidden = state.tab !== t; });
		$('lead').textContent = LEADS[state.tab];
		const btn = $('useBtn');
		btn.textContent = state.tab === 'agents' ? 'Use in chat' : state.tab === 'rules' ? 'New instruction' : 'Refresh';
		btn.disabled = state.tab !== 'agents' && !state.hasProject;
		renderTabs();
		if (state.tab === 'context') renderContext();
	}

	const cur = () => state.agents.find(a => a.id === state.selected);
	function save() {
		clearTimeout(saveTimer);
		const d = draft; // the agent being edited now, even if another is selected before the timer fires
		saveTimer = setTimeout(() => {
			const { flow, kind, file, ...agent } = d;
			vscode.postMessage({ type: 'save', agent });
			flashSaved();
		}, 350);
	}
	function change(fn) { fn(draft); renderFlow(); save(); }

	function renderList() {
		const box = $('list'); box.replaceChildren(el('span', 'group-title', 'Agents'));
		state.agents.forEach(a => {
			const c = el('button', 's-card' + (a.id === state.selected ? ' sel' : ''));
			const g = el('span', 'glyph'); g.innerHTML = lcIdenticon('agent:' + a.id);
			const t = el('span', 's-card__text'); t.append(el('span', 's-card__name', a.name), el('span', 's-card__sum', a.summary || 'No description yet'));
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
		const ht = el('div'); ht.append(el('div', 's-flow__name', p.name), el('div', 's-flow__role', p.role || 'Describe its job on the right to tell this agent what it is for.'));
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
		const fs = el('div', 'field'); fs.append(el('label', '', 'Short description')); const si = el('input', 'input'); si.value = p.summary; si.maxLength = 120; si.placeholder = 'One line shown under its name'; si.oninput = () => change(d => { d.summary = si.value; }); fs.append(si);
		id.append(fn, fs);
		// job
		const job = section('job', 'Its job', 'Describe in plain words what this agent is for. It reads this before every request.');
		const ta = el('textarea', 'input'); ta.value = p.role; ta.maxLength = 2000; ta.placeholder = 'e.g. Find where contracts waste gas and explain each saving in plain words.'; ta.oninput = () => change(d => { d.role = ta.value; }); job.append(ta);
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
		const md = el('button', 'button button-xs', 'Edit as Markdown'); md.title = 'Open ' + p.file + ' in the editor'; md.onclick = () => vscode.postMessage({ type: 'openAgent', id: p.id });
		mrow.append(md, dup); mg.append(mrow);
		if (p.kind !== 'builtin') { const rm = el('button', 'button button-xs', p.kind === 'customized' ? 'Reset to default' : 'Delete agent'); rm.onclick = () => vscode.postMessage({ type: 'remove', id: p.id }); mrow.append(rm); }
		mg.append(el('div', 'note', p.kind === 'builtin' ? 'Built-in agent. Change anything here, or edit it as Markdown, and a copy is saved for this project.' : 'Saved as ' + p.file + ' — a Markdown file you can also write by hand and share through git.'));
		box.append(id, job, rules, can, safety, checks, model, st, mg);
		box.scrollTop = top;
	}

	// ---- instructions ----
	const APPLY = { always: 'Always', files: 'Matching files', manual: 'On mention' };
	const curRule = () => state.rules.find(r => r.id === state.selectedRule);
	function saveRule() {
		clearTimeout(ruleTimer);
		const d = ruleDraft;
		ruleTimer = setTimeout(() => { vscode.postMessage({ type: 'saveRule', rule: d }); flashSaved(); }, 350);
	}
	function changeRule(fn) { fn(ruleDraft); saveRule(); }

	function renderRuleList() {
		const box = $('rlist'); box.replaceChildren(el('span', 'group-title', 'Instructions'));
		state.rules.forEach(r => {
			const c = el('button', 's-card' + (r.id === state.selectedRule ? ' sel' : ''));
			const g = el('span', 'glyph'); g.innerHTML = lcIdenticon('rule:' + r.id);
			const first = (r.body.split('\\n').find(l => l.trim() && l.trim()[0] !== '#') || '').trim();
			const t = el('span', 's-card__text'); t.append(el('span', 's-card__name', r.title), el('span', 's-card__sum', r.description || first || 'Empty'));
			const k = el('span', 's-card__kind'); k.append(el('span', 'pill', APPLY[r.apply]));
			if (r.cut || r.left) { k.append(' ', el('span', 'pill warn', r.left ? 'Not sent' : 'Cut')); }
			t.append(k); c.append(g, t);
			c.onclick = () => { if (r.id !== state.selectedRule) vscode.postMessage({ type: 'selectRule', id: r.id }); };
			box.append(c);
		});
		if (state.hasProject) { const n = el('button', 'button button-sm button-block s-new', '+ New instruction'); n.onclick = () => vscode.postMessage({ type: 'createRule' }); box.append(n); }
	}

	function renderRuleEdit() {
		const box = $('redit'); box.replaceChildren();
		const r = ruleDraft;
		if (!r) {
			const e = el('div', 'empty');
			e.append(el('h2', '', state.hasProject ? 'No instructions yet' : 'Open a project first'),
				el('p', '', state.hasProject ? 'Tell Lightchain AI how this project is built: the Solidity version, the libraries you use, what must always be tested, what must never happen. Every agent follows them.' : 'Instructions are saved with a project, so open or create one.'));
			if (state.hasProject) { const b = el('button', 'button button-primary', 'Write the first instruction'); b.onclick = () => vscode.postMessage({ type: 'createRule' }); e.append(b); }
			box.append(e); return;
		}
		const ti = el('input', 'input r-title'); ti.value = r.title; ti.maxLength = 60; ti.placeholder = 'Name this instruction'; ti.disabled = !!r.fixed; ti.oninput = () => changeRule(d => { d.title = ti.value; });
		box.append(ti);
		if (!r.fixed) { const di = el('input', 'input'); di.value = r.description || ''; di.maxLength = 160; di.placeholder = 'Short description (optional)'; di.oninput = () => changeRule(d => { d.description = di.value; }); box.append(di); }
		const when = el('div', 'zpanel'); when.append(el('div', 'zlabel', 'When it applies'));
		if (r.fixed) {
			when.append(el('div', 'note', r.file + ' always applies. It is the file other tools read too, so it stays one plain Markdown file.'));
		} else {
			const opt = (key, title, help) => { const t = el('div', 'toggle'); t.append(el('span', 'check' + (r.apply === key ? ' on' : ''), '✓')); const tx = el('span', 'toggle__text'); tx.append(el('span', 'toggle__title', title), el('span', 'toggle__help', help)); t.append(tx); t.onclick = () => { changeRule(d => { d.apply = key; }); renderRuleEdit(); if (key === 'files') { const gi = document.querySelector('.r-globs'); if (gi) gi.focus(); } }; return t; };
			when.append(opt('always', 'Always', 'Sent at the start of every conversation'));
			when.append(opt('files', 'For matching files', 'Added when a matching file is open or mentioned'));
			if (r.apply === 'files') {
				const gi = el('input', 'input mono r-globs'); gi.value = (r.globs || []).join(', '); gi.placeholder = 'src/**/*.sol, *.t.sol'; gi.spellcheck = false;
				gi.oninput = () => changeRule(d => { d.globs = gi.value.split(',').map(x => x.trim()).filter(Boolean); });
				when.append(gi);
			}
			when.append(opt('manual', 'Only when mentioned', 'Type @ in the chat and pick it'));
		}
		box.append(when);
		const body = el('div', 'r-body zpanel'); body.append(el('div', 'zlabel', 'Instruction'));
		const ta = el('textarea', 'input'); ta.value = r.body; ta.spellcheck = false; ta.placeholder = 'Plain sentences or Markdown. For example: Use Solidity ^0.8.24. Every external function needs a test.';
		const count = el('span', '', num(r.body.trim().length) + ' characters');
		ta.oninput = () => { changeRule(d => { d.body = ta.value; }); count.textContent = num(ta.value.trim().length) + ' characters'; };
		const foot = el('div', 'r-foot'); foot.append(count); body.append(ta, foot); box.append(body);
	}

	function renderRuleSide() {
		const box = $('rside'); box.replaceChildren();
		const always = state.rules.filter(x => x.apply === 'always');
		const over = always.some(x => x.cut || x.left);
		const sent = el('div', 'zpanel'); sent.append(el('div', 'zlabel', 'Sent with every conversation'));
		const meter = el('div', 'meter' + (over ? ' over' : '')); const bar = el('i'); bar.style.width = Math.min(100, Math.round(100 * state.used / state.budget)) + '%'; meter.append(bar);
		sent.append(meter, el('div', 'meter-text', num(state.used) + ' of ' + num(state.budget) + ' characters'));
		if (over) sent.append(el('div', 'note', 'Over the limit: instructions marked Cut are shortened and Not sent are left out. Keep always-on instructions short, or apply them to matching files only.'));
		else sent.append(el('div', 'note', 'Lightchain models read a small window, so always-on instructions share ' + num(state.budget) + ' characters. Instructions for matching files are added only when needed.'));
		always.forEach(x => { const row = el('div', 'row'); row.append(el('span', 'grow', x.title), el('span', 'num', num(x.chars))); if (x.cut || x.left) row.append(el('span', 'pill warn', x.left ? 'Not sent' : 'Cut')); sent.append(row); });
		box.append(sent);
		const r = curRule();
		if (r) {
			const file = el('div', 'zpanel'); file.append(el('div', 'zlabel', 'File'), el('span', 'path mono', r.file));
			const row = el('div', 'manage'); const md = el('button', 'button button-xs', 'Edit as Markdown'); md.onclick = () => vscode.postMessage({ type: 'openRule', id: r.id });
			const rm = el('button', 'button button-xs', 'Delete'); rm.onclick = () => vscode.postMessage({ type: 'removeRule', id: r.id });
			row.append(md, rm); file.append(row); box.append(file);
		}
		const tip = el('div', 'zpanel'); tip.append(el('div', 'zlabel', 'Good to know'));
		tip.append(el('div', 'note', 'New instructions are saved in ' + state.rulesDir + '/. An AGENTS.md at the project root is read too, so instructions written for other tools already work here.'));
		box.append(tip);
	}

	// ---- project context ----
	function renderContext() {
		const main = $('cmain'), side = $('cside');
		const active = document.activeElement && document.activeElement.id === 'cq';
		const caret = active ? document.activeElement.selectionStart : 0;
		main.replaceChildren(); side.replaceChildren();
		const idx = el('div', 'zpanel'); idx.append(el('div', 'zlabel', 'Local project search'));
		idx.append(el('p', 'c-lead', 'When you ask for something, Studio searches your project on this machine and attaches the few pieces of code your request is about. Nothing is uploaded to build the index.'));
		const stats = el('div', 'stats');
		const stat = (n, label) => { const s = el('div', 'stat'); s.append(el('b', '', context ? num(n) : '–'), el('span', '', label)); return s; };
		stats.append(stat(context ? context.files : 0, 'files indexed'), stat(context ? context.chunks : 0, 'searchable pieces'));
		idx.append(stats);
		const on = !context || context.enabled;
		const tg = el('div', 'toggle'); tg.append(el('span', 'check' + (on ? ' on' : ''), '✓')); const tx = el('span', 'toggle__text'); tx.append(el('span', 'toggle__title', 'Attach related code automatically'), el('span', 'toggle__help', 'Shown under your message as outlined chips, so you always see what was added')); tg.append(tx);
		tg.onclick = () => vscode.postMessage({ type: 'localContext', on: !on }); idx.append(tg);
		main.append(idx);
		const tryp = el('div', 'zpanel'); tryp.append(el('div', 'zlabel', 'Try it'));
		const qi = el('input', 'input'); qi.id = 'cq'; qi.value = query; qi.placeholder = 'What would you ask? e.g. who can withdraw the fees';
		qi.oninput = () => { query = qi.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (query.trim()) vscode.postMessage({ type: 'search', query }); else { hits = null; renderContext(); } }, 180); };
		tryp.append(qi);
		if (hits) {
			if (!hits.length) tryp.append(el('div', 'note', 'Nothing in the project matches closely enough, so nothing would be attached.'));
			hits.forEach(h => {
				const b = el('button', 'hit'); const head = el('div', 'hit__head'); head.append(el('span', '', h.path), el('span', 'where', 'lines ' + h.start + '–' + h.end + (h.label ? ' · ' + h.label : '')));
				b.append(head, el('pre', '', h.preview)); b.title = 'Open in the editor'; b.onclick = () => vscode.postMessage({ type: 'openFile', path: h.path, line: h.start }); tryp.append(b);
			});
		}
		main.append(tryp);
		if (active) { const again = $('cq'); again.focus(); again.selectionStart = again.selectionEnd = caret; }
		const map = el('div', 'zpanel'); map.append(el('div', 'zlabel', 'Every conversation starts with'));
		if (!context) { map.append(el('div', 'note', 'Reading the project…')); }
		else if (!context.map) { map.append(el('div', 'note', 'Nothing yet. Add a contract or an instruction and it shows up here.')); }
		else {
			const pct = Math.min(100, Math.round(100 * context.mapTokens / context.window));
			const meter = el('div', 'meter'); const bar = el('i'); bar.style.width = pct + '%'; meter.append(bar);
			map.append(meter, el('div', 'meter-text', 'About ' + num(context.mapTokens) + ' of ' + num(context.window) + ' tokens of the model window'), el('pre', 'map', context.map));
		}
		side.append(map);
	}

	$('useBtn').onclick = () => {
		if (state.tab === 'agents') { if (draft) vscode.postMessage({ type: 'use', id: draft.id }); }
		else if (state.tab === 'rules') vscode.postMessage({ type: 'createRule' });
		else { context = null; renderContext(); vscode.postMessage({ type: 'refreshContext' }); }
	};
	window.addEventListener('message', e => {
		const m = e.data; if (!m) return;
		if (m.type === 'context') { context = m; if (state.tab === 'context') renderContext(); return; }
		if (m.type === 'hits') { if (m.query === query) { hits = m.hits; if (state.tab === 'context') renderContext(); } return; }
		if (m.type !== 'state') return;
		const switched = m.selected !== state.selected;
		const ruleSwitched = m.selectedRule !== state.selectedRule;
		state = m;
		// the instruction editor is rebuilt only when another one is shown, so typing is never interrupted
		if (ruleSwitched || !ruleDraft || !$('redit').contains(document.activeElement)) {
			const r = curRule();
			ruleDraft = r ? JSON.parse(JSON.stringify(r)) : null;
			renderRuleEdit();
		}
		renderRuleList(); renderRuleSide(); showTab();
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
