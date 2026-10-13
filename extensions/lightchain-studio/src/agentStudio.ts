import * as vscode from 'vscode';
import { AGENTS_DIR, AGENT_TEMPLATES, AgentDraft, AgentProfile, AgentProfiles, BUILTIN_AGENTS, draftFromText, draftPrompt, flow, parseDraft, profileFromDraft } from './agent/profiles';
import type { InferenceProvider } from './agent/agent';
import { PERSONAL_PREFIX, RULES_BUDGET, RULES_DIR, Rule, RuleStore, renderRules } from './agent/rules';
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
		/** A one-off Lightchain AI request (drafting an agent); undefined without a wallet or model. */
		private readonly sideProvider: () => InferenceProvider | undefined = () => undefined,
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

	/** Opens the Studio on the guided "new agent" setup. */
	startNew(): void {
		this.open(undefined, 'agents');
		void this.panel?.webview.postMessage({ type: 'wizard' });
	}

	/**
	 * Turns a description into a draft agent: Lightchain AI writes it when a wallet
	 * is connected (one request); otherwise, or if that fails, it is drafted here.
	 */
	private async draft(description: string): Promise<void> {
		const post = (draft: AgentDraft, by: 'ai' | 'local', note?: string) => void this.panel?.webview.postMessage({ type: 'drafted', draft, by, note });
		if (!description.trim()) {
			return;
		}
		const provider = this.sideProvider();
		if (!provider) {
			return post(draftFromText(description), 'local');
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 90_000);
		try {
			let reply = '';
			for await (const delta of provider.chat([{ role: 'user', content: draftPrompt(description) }], abort.signal, status => void this.panel?.webview.postMessage({ type: 'draftStatus', text: status }))) {
				reply += delta;
			}
			const draft = parseDraft(reply);
			post(draft ?? draftFromText(description), draft ? 'ai' : 'local', draft ? undefined : 'Lightchain AI answered in a form Studio could not read, so this is a simple draft. Adjust it below.');
		} catch (err) {
			post(draftFromText(description), 'local', `Lightchain AI was not available (${(err as Error).message.split('\n')[0].slice(0, 120)}), so this is a simple draft. Adjust it below.`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** A new instruction file, opened for writing. */
	async createRule(scope?: 'project' | 'personal'): Promise<void> {
		const rule = await this.rules.create(undefined, scope);
		this.open(undefined, 'rules', rule.id);
	}

	/** Where an agent's file is, as shown to the user. */
	private relFile(id: string, scope?: 'project' | 'personal'): string {
		return scope === 'personal' ? `${PERSONAL_PREFIX}${id}.md` : `${AGENTS_DIR}/${id}.md`;
	}

	private push(): void {
		const agents = this.profiles.all.map(p => ({
			...p, flow: flow(p), file: this.relFile(p.id, p.scope),
			kind: p.builtin ? 'builtin' : this.profiles.isCustomized(p.id) ? 'customized' : p.scope === 'personal' ? 'personal' : 'project',
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
			scopes: this.profiles.scopes, ruleScopes: this.rules.scopes,
			rules, selectedRule: this.selectedRule, budget: RULES_BUDGET, used: sent.text.length, rulesDir: RULES_DIR,
			templates: AGENT_TEMPLATES, canDraftWithAi: !!this.sideProvider(),
		});
	}

	/** What the Project context tab shows: the local index and what every conversation starts with. */
	private async pushContext(force = false): Promise<void> {
		await this.index.refresh(force).catch(() => undefined);
		const map = await this.projectMap().catch(() => '');
		const window = vscode.workspace.getConfiguration('lightchain.ai').get<number>('contextTokens', 8_192);
		void this.panel?.webview.postMessage({ type: 'context', files: this.index.index.files, chunks: this.index.index.chunks, enabled: this.index.enabled, map, mapTokens: estimateTokens(map), window });
	}

	private async reveal(target: string | vscode.Uri | undefined, line?: number): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		const uri = typeof target === 'string' ? root && vscode.Uri.joinPath(root, target) : target;
		if (!uri) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		const at = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: at });
	}

	private async onMessage(m: any): Promise<void> {
		try {
			switch (m?.type) {
				case 'ready':
					return this.push();
				case 'newAgent':
					// the guided setup, e.g. from the chat's "+ New agent"
					this.open(undefined, 'agents');
					void this.panel?.webview.postMessage({ type: 'wizard' });
					return;
				case 'draft':
					return this.draft(String(m.description ?? ''));
				case 'createFrom': {
					const d = m.draft as AgentDraft;
					const id = this.profiles.newId(String(d?.name || 'New agent'));
					await this.profiles.put(profileFromDraft(id, { name: String(d?.name || 'New agent'), summary: String(d?.summary ?? ''), role: String(d?.role ?? ''), rules: Array.isArray(d?.rules) ? d.rules : [], access: d?.access === 'answer' || d?.access === 'auto' ? d.access : 'suggest', starters: Array.isArray(d?.starters) ? d.starters : [] }), m.scope === 'personal' || m.scope === 'project' ? m.scope : undefined);
					this.selected = id;
					return this.push();
				}
				case 'tab':
					this.tab = m.tab === 'rules' || m.tab === 'context' ? m.tab : 'agents';
					this.push();
					return this.tab === 'context' ? this.pushContext() : undefined;
				case 'selectRule':
					this.selectedRule = String(m.id);
					return this.push();
				case 'createRule':
					return this.createRule(m.scope === 'personal' || m.scope === 'project' ? m.scope : undefined);
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
					return r ? this.reveal(this.rules.uri(r)) : undefined;
				}
				case 'openAgent': {
					// a built-in has no file until it is saved for this project
					const p = this.profiles.get(String(m.id));
					if (p.builtin) {
						await this.profiles.put(p);
					}
					return this.reveal(this.profiles.fileOf(p.id));
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
					await this.profiles.put(m.agent as AgentProfile, m.scope === 'personal' || m.scope === 'project' ? m.scope : undefined);
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

	/* plain-language summary of the selected agent */
	.say { max-width: 580px; margin: 0 0 20px; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--zap); background: rgba(91, 75, 255, 0.06); color: var(--lc-text-primary); font-size: 13.5px; line-height: 1.55; }
	/* one plain choice instead of five switches */
	.choice { display: flex; align-items: flex-start; gap: 12px; width: 100%; margin-bottom: 8px; padding: 11px 12px; border: 1px solid var(--zap); border-radius: 12px; background: transparent; color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease; }
	.choice:last-child { margin-bottom: 0; }
	.choice:hover { border-color: var(--zap-strong); }
	.choice.on { border-color: var(--lc-accent); background: rgba(91, 75, 255, 0.1); }
	.choice .dot { flex: none; width: 16px; height: 16px; margin-top: 2px; border: 2px solid var(--lc-rule-strong); border-radius: 50%; transition: all .2s ease; }
	.choice.on .dot { border-color: var(--lc-accent); background: radial-gradient(var(--lc-accent) 45%, transparent 50%); }
	.choice__text { display: flex; flex-direction: column; }
	.choice__title { font-size: 13.5px; font-weight: 500; line-height: 1.4; }
	.choice__help { color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.more { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 10px 16px; border: 1px dashed var(--zap-strong); border-radius: 14px; background: transparent; color: var(--lc-text-secondary); font-size: 13px; cursor: pointer; transition: border-color .2s ease, color .2s ease; }
	.more:hover { border-color: var(--lc-accent); color: var(--lc-text-strong); }
	.more small { color: var(--lc-text-tertiary); font-size: 12px; }

	/* new agent: describe it, or start from a ready-made one */
	.wiz { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 20px; background: rgba(7, 7, 16, 0.78); backdrop-filter: blur(6px); animation: fadeIn var(--lc-motion) ease; }
	.wiz__card { width: 100%; max-width: 620px; max-height: 100%; overflow-y: auto; padding: 24px; border: 1px solid var(--lc-rule-strong); border-radius: 16px; background: var(--lc-surface-2); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5); }
	.wiz__card h2 { margin: 0 0 4px; color: var(--lc-text-strong); font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
	.wiz__card > p { margin: 0 0 16px; color: var(--lc-text-tertiary); font-size: 13px; }
	.wiz label { display: block; margin: 16px 0 6px; color: var(--lc-text-secondary); font-size: 12px; }
	.wiz textarea.input { min-height: 76px; }
	.wiz__row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
	.wiz__hint { flex: 1; color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.45; }
	.wiz__hint.warn { color: #fde68a; }
	.ideas { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
	.idea { padding: 10px 12px; border: 1px solid var(--zap); border-radius: 12px; background: transparent; color: var(--lc-text-primary); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease; }
	.idea:hover, .idea.on { border-color: var(--lc-accent); background: rgba(91, 75, 255, 0.1); }
	.idea b { display: block; font-size: 13px; font-weight: 500; }
	.idea span { display: block; margin-top: 2px; color: var(--lc-text-tertiary); font-size: 12px; line-height: 1.4; }
	.wiz__foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

	/* instructions: list, editor, what the AI receives */
	/* LCAIPresale .lc-bridge__notice--warn colours */
	.pill.warn { border-color: rgba(234, 179, 8, 0.3); background: rgba(234, 179, 8, 0.1); color: #fde68a; }
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
	.meter.over i { background: #fde68a; }
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
<div class="wiz" id="wiz" hidden></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	let state = { tab: 'agents', agents: [], selected: null, models: [], hasProject: true, rules: [], selectedRule: null, budget: 2400, used: 0, rulesDir: '', templates: [], canDraftWithAi: false, scopes: [], ruleScopes: [] };
	let draft = null, focusSec = null, saveTimer = null;
	let ruleDraft = null, ruleTimer = null;
	let advanced = !!(vscode.getState() || {}).advanced;
	let wiz = null; // the new-agent setup: { description, draft, busy, note, by, picked }
	let context = null, hits = null, query = '', searchTimer = null;
	const LEADS = {
		agents: 'Agents are helpers with a job. Pick one to see how it works, change it in plain words, or make your own.',
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
		btn.disabled = state.tab === 'rules' && !state.ruleScopes.length;
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
			const k = el('span', 's-card__kind'); k.append(el('span', 'pill', a.kind === 'builtin' ? 'Ready-made' : a.kind === 'customized' ? 'Changed by you' : a.kind === 'personal' ? 'This wallet' : 'This project')); t.append(k);
			c.append(g, t);
			c.onclick = () => { if (a.id !== state.selected) { focusSec = null; vscode.postMessage({ type: 'select', id: a.id }); } };
			box.append(c);
		});
		const n = el('button', 'button button-sm button-block s-new', '+ New agent'); n.onclick = () => openWizard(); box.append(n);
	}

	function computeFlow(p) {
		return [
			{ id: 'understand', label: 'Understands your request', detail: 'Reads what you asked, the file you have open and the instructions of your project', on: true, sec: 'job' },
			{ id: 'read', label: 'Looks at your project', detail: 'Opens and searches the files it needs', on: p.can.read, sec: 'access' },
			{ id: 'plan', label: 'Makes a plan', detail: 'Decides what to do, following its rules', on: true, sec: 'rules' },
			{ id: 'write', label: 'Changes your files', detail: p.can.write ? (p.approval === 'ask' ? 'Shows you each change — you accept or reject it' : 'Makes the changes — you can undo them') : 'Not allowed: it only answers in the chat', on: p.can.write, sec: 'access' },
			{ id: 'build', label: 'Checks the code works', detail: p.can.build ? (p.check ? 'Compiles the contracts after every change and fixes errors' : 'Compiles the contracts when it needs to') : 'Not allowed', on: p.can.build, sec: 'access' },
			{ id: 'test', label: 'Runs the tests', detail: p.can.test ? (p.check ? 'Runs your tests after every change and fixes failures' : 'Runs your tests when you ask') : 'Not allowed', on: p.can.test, sec: 'access' },
			{ id: 'answer', label: 'Tells you what it did', detail: 'A short summary, and what to try next', on: true, sec: 'job' },
		];
	}
	// the same wording as describeAgent / accessOf / withAccess in agent/profiles.ts
	const accessOf = p => !p.can.write ? 'answer' : p.approval === 'auto' ? 'auto' : 'suggest';
	function setAccess(p, a) {
		if (a === 'answer') { p.can.read = true; p.can.write = false; p.can.test = false; p.approval = 'ask'; p.check = false; }
		else { p.can.read = true; p.can.write = true; p.can.build = true; p.can.test = true; p.approval = a === 'auto' ? 'auto' : 'ask'; p.check = true; }
	}
	function describe(p) {
		const checks = [p.can.build && 'checks that the code still works', p.can.test && 'runs the tests'].filter(Boolean).join(' and ');
		if (!p.can.write) return 'It looks at your project' + (p.can.build ? ' and can check that the code works' : '') + ', and answers in the chat. It never changes your files.';
		const after = p.check && checks ? ' After every change it ' + checks + ', and fixes what it broke.' : '';
		return p.approval === 'auto' ? 'It makes changes on its own — you can undo any of them from the chat.' + after : 'It shows you each change and waits for your OK before anything is saved.' + after;
	}
	// where something is saved: with the project (the team gets it through git) or with the wallet (yours, everywhere)
	const PLACES = [
		['project', 'This project', 'Saved in the project and shared with your team through git.'],
		['personal', 'This wallet', 'Only yours: it follows this wallet into every project you open.'],
	];
	function placeChoices(available, current, pick) {
		return PLACES.filter(([key]) => available.includes(key)).map(([key, title, help]) => {
			const b = el('button', 'choice' + (current === key ? ' on' : '')); b.type = 'button';
			const t = el('span', 'choice__text'); t.append(el('span', 'choice__title', title), el('span', 'choice__help', help));
			b.append(el('span', 'dot'), t); b.onclick = () => pick(key); return b;
		});
	}
	const ACCESS = [
		['answer', 'Only answer', 'It reads your project and explains. It can never change a file.'],
		['suggest', 'Suggest changes', 'It shows you each change and you accept or reject it.'],
		['auto', 'Work on its own', 'It makes the changes right away. You can undo them from the chat.'],
	];
	function accessChoices(current, pick) {
		return ACCESS.map(([key, title, help]) => {
			const b = el('button', 'choice' + (current === key ? ' on' : '')); b.type = 'button';
			const t = el('span', 'choice__text'); t.append(el('span', 'choice__title', title), el('span', 'choice__help', help));
			b.append(el('span', 'dot'), t); b.onclick = () => pick(key); return b;
		});
	}

	function renderFlow() {
		const box = $('flow'); box.replaceChildren();
		const p = draft; if (!p) return;
		const head = el('div', 's-flow__head'); const g = el('span', 'glyph'); g.innerHTML = lcIdenticon('agent:' + p.id);
		const ht = el('div'); ht.append(el('div', 's-flow__name', p.name), el('div', 's-flow__role', p.role || 'Describe its job on the right to tell this agent what it is for.'));
		head.append(g, ht); box.append(head);
		box.append(el('div', 'say', describe(p)));
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
		(p.starters.filter(Boolean).length ? p.starters.filter(Boolean) : ['Explain this project']).forEach(sx => { const c = el('button', 'tchip', sx); c.onclick = () => vscode.postMessage({ type: 'use', id: p.id, prompt: sx }); chips.append(c); });
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
		// one plain choice; the single switches live under "More settings"
		const access = section('access', 'What may it do?', 'Pick how much this agent does on its own.');
		access.append(...accessChoices(accessOf(p), key => { change(d => setAccess(d, key)); renderProps(); }));
		// permissions
		const can = section('can', 'Exactly what it may do', 'Switch off anything this agent should never touch.');
		const perm = (k, title, help) => can.append(toggle(title, help, p.can[k], () => change(d => { d.can[k] = !d.can[k]; })));
		perm('read', 'Look at your project', 'Open and search files');
		perm('write', 'Change files', 'Create and edit contracts, tests and scripts');
		perm('build', 'Check the code works', 'Compile the contracts (forge build)');
		perm('test', 'Run the tests', 'Run your tests and read the results (forge test)');
		perm('run', 'Run terminal commands', 'Advanced — always asks you before each command');
		// safety
		const safety = section('safety', 'When it changes files');
		const radio = el('div', 'radio');
		radio.append(toggle('Ask me first', 'Each change shows in the file; you accept or reject it', p.approval === 'ask', () => change(d => { d.approval = 'ask'; })));
		radio.append(toggle('Apply automatically', 'Faster; every change can still be undone from the chat', p.approval === 'auto', () => change(d => { d.approval = 'auto'; })));
		safety.append(radio);
		if (!p.can.write) safety.append(el('div', 'note', 'This agent may not change files, so this does not apply.'));
		// checks
		const checks = section('checks', 'Double-checking');
		checks.append(toggle('Check and test after every change', 'It fixes errors and failing tests on its own (up to 2 tries)', p.check, () => change(d => { d.check = !d.check; })));
		// model
		const model = section('model', 'AI model', 'Which Lightchain model this agent thinks with.');
		const ms = el('select', 'input'); const none = el('option', '', 'Same as the chat'); none.value = ''; ms.append(none);
		state.models.forEach(m => { const o = el('option', '', m); o.value = m; o.selected = m === p.model; ms.append(o); });
		ms.onchange = () => change(d => { d.model = ms.value || undefined; }); model.append(ms);
		// starters
		// where it lives (a ready-made agent has no file until it is changed)
		const place = section('place', 'Where it lives', 'Move it between this project and your wallet at any time.');
		if (p.kind !== 'builtin' && state.scopes.length > 1) {
			place.append(...placeChoices(state.scopes, p.scope || 'project', key => { if (key === (p.scope || 'project')) return; draft.scope = key; const { flow, kind, file, ...agent } = draft; vscode.postMessage({ type: 'save', agent, scope: key }); flashSaved(); }));
		}
		const st = section('starters', 'Example requests', 'Shown as one-click suggestions when you pick this agent.');
		[0, 1, 2].forEach(i => { const si2 = el('input', 'input'); si2.style.marginBottom = '6px'; si2.value = p.starters[i] || ''; si2.placeholder = 'e.g. Add a withdraw function'; si2.maxLength = 120; si2.oninput = () => change(d => { d.starters[i] = si2.value; d.starters = d.starters.map(s => s || '').slice(0, 3); }); st.append(si2); });
		// manage
		const mg = section('manage', 'Manage');
		const mrow = el('div', 'manage'); const dup = el('button', 'button button-xs', 'Duplicate'); dup.onclick = () => vscode.postMessage({ type: 'create', from: p.id });
		const md = el('button', 'button button-xs', 'Edit as Markdown'); md.title = 'Open ' + p.file + ' in the editor'; md.onclick = () => vscode.postMessage({ type: 'openAgent', id: p.id });
		mrow.append(md, dup); mg.append(mrow);
		if (p.kind !== 'builtin') { const rm = el('button', 'button button-xs', p.kind === 'customized' ? 'Reset to default' : 'Delete agent'); rm.onclick = () => vscode.postMessage({ type: 'remove', id: p.id }); mrow.append(rm); }
		mg.append(el('div', 'note', p.kind === 'builtin' ? 'Built-in agent. Change anything here, or edit it as Markdown, and a copy is saved for this project.' : 'Saved as ' + p.file + ' — a Markdown file you can also write by hand and share through git.'));
		const more = el('button', 'more'); more.type = 'button';
		more.append(el('span', '', advanced ? 'Fewer settings' : 'More settings'), el('small', '', advanced ? '' : 'single permissions, AI model, example requests'));
		more.onclick = () => { advanced = !advanced; vscode.setState({ advanced }); renderProps(); };
		box.append(id, job, rules, access, ...(p.kind !== 'builtin' && state.scopes.length > 1 ? [place] : []), ...(advanced ? [can, safety, checks, model, st] : []), more, mg);
		box.scrollTop = top;
	}

	// ---- new agent: describe it, or start from a ready-made one ----
	function openWizard() {
		wiz = { description: '', busy: false, note: '', warn: false, picked: null, scope: state.scopes[0] || 'project', draft: { name: '', summary: '', role: '', rules: [], access: 'suggest', starters: [] } };
		renderWizard();
		const first = document.getElementById('wizDesc'); if (first) first.focus();
	}
	function closeWizard() { wiz = null; $('wiz').hidden = true; $('wiz').replaceChildren(); }
	function renderWizard() {
		const box = $('wiz'); if (!wiz) { box.hidden = true; return; }
		const keep = document.activeElement && document.activeElement.id; const caret = keep ? document.activeElement.selectionStart : null;
		const card = el('div', 'wiz__card');
		card.append(el('h2', '', 'New agent'), el('p', '', 'An agent is a helper with one job. Say what you need in your own words, or start from a ready-made one.'));
		const dl = el('label', '', 'What should it help you with?'); dl.htmlFor = 'wizDesc';
		const desc = el('textarea', 'input'); desc.id = 'wizDesc'; desc.value = wiz.description; desc.maxLength = 600; desc.placeholder = 'e.g. Check my contracts for mistakes before I deploy and explain each one simply';
		desc.oninput = () => { wiz.description = desc.value; draftBtn.disabled = wiz.busy || !desc.value.trim(); };
		const row = el('div', 'wiz__row');
		const hint = el('span', 'wiz__hint' + (wiz.warn ? ' warn' : ''), wiz.note || (state.canDraftWithAi ? 'Lightchain AI writes the agent from your description (one request).' : 'Studio drafts the agent from your description. Connect a wallet to let Lightchain AI write it.'));
		const draftBtn = el('button', 'button button-sm', wiz.busy ? 'Writing…' : 'Write it for me'); draftBtn.type = 'button'; draftBtn.disabled = wiz.busy || !wiz.description.trim();
		draftBtn.onclick = () => { wiz.busy = true; wiz.note = 'Writing your agent…'; wiz.warn = false; renderWizard(); vscode.postMessage({ type: 'draft', description: wiz.description }); };
		row.append(hint, draftBtn);
		card.append(dl, desc, row);
		card.append(el('label', '', 'Or start from a ready-made one'));
		const ideas = el('div', 'ideas');
		(state.templates || []).forEach(t => {
			const b = el('button', 'idea' + (wiz.picked === t.id ? ' on' : '')); b.type = 'button'; b.append(el('b', '', t.name), el('span', '', t.summary));
			b.onclick = () => { wiz.picked = t.id; wiz.draft = { name: t.name, summary: t.summary, role: t.role, rules: t.rules.slice(), access: t.access, starters: t.starters.slice() }; wiz.note = ''; wiz.warn = false; renderWizard(); };
			ideas.append(b);
		});
		card.append(ideas);
		const nl = el('label', '', 'Name'); nl.htmlFor = 'wizName';
		const name = el('input', 'input'); name.id = 'wizName'; name.value = wiz.draft.name; name.maxLength = 40; name.placeholder = 'e.g. Safety Checker';
		name.oninput = () => { wiz.draft.name = name.value; create.disabled = !name.value.trim(); };
		card.append(nl, name);
		if (wiz.draft.role) {
			const jl = el('label', '', 'Its job'); jl.htmlFor = 'wizJob';
			const job = el('textarea', 'input'); job.id = 'wizJob'; job.value = wiz.draft.role; job.maxLength = 2000; job.oninput = () => { wiz.draft.role = job.value; };
			card.append(jl, job);
		}
		if (state.scopes.length > 1) { card.append(el('label', '', 'Where should it live?')); card.append(...placeChoices(state.scopes, wiz.scope, key => { wiz.scope = key; renderWizard(); })); }
		card.append(el('label', '', 'What may it do?'));
		card.append(...accessChoices(wiz.draft.access, key => { wiz.draft.access = key; renderWizard(); }));
		const foot = el('div', 'wiz__foot');
		const cancel = el('button', 'button button-sm', 'Cancel'); cancel.type = 'button'; cancel.onclick = closeWizard;
		const create = el('button', 'button button-primary button-sm', 'Create agent'); create.type = 'button'; create.disabled = !wiz.draft.name.trim();
		create.onclick = () => {
			const d = wiz.draft;
			// nothing drafted yet: the description itself is the job
			if (!d.role && wiz.description.trim()) { d.role = wiz.description.trim(); }
			vscode.postMessage({ type: 'createFrom', draft: d, scope: wiz.scope }); closeWizard();
		};
		foot.append(cancel, create); card.append(foot);
		box.replaceChildren(card); box.hidden = false;
		box.onclick = e => { if (e.target === box) closeWizard(); };
		if (keep) { const again = document.getElementById(keep); if (again) { again.focus(); if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret); } }
	}
	document.addEventListener('keydown', e => { if (e.key === 'Escape' && wiz) closeWizard(); });

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
		if (state.ruleScopes.length) { const n = el('button', 'button button-sm button-block s-new', '+ New instruction'); n.onclick = () => vscode.postMessage({ type: 'createRule' }); box.append(n); }
	}

	function renderRuleEdit() {
		const box = $('redit'); box.replaceChildren();
		const r = ruleDraft;
		if (!r) {
			const e = el('div', 'empty');
			e.append(el('h2', '', state.ruleScopes.length ? 'No instructions yet' : 'Open a project or connect a wallet first'),
				el('p', '', state.ruleScopes.length ? 'Tell Lightchain AI how this project is built: the Solidity version, the libraries you use, what must always be tested, what must never happen. Every agent follows them.' : 'Instructions are saved with a project (shared with your team) or with your wallet (yours everywhere).'));
			if (state.ruleScopes.length) { const b = el('button', 'button button-primary', 'Write the first instruction'); b.onclick = () => vscode.postMessage({ type: 'createRule' }); e.append(b); }
			box.append(e); return;
		}
		const ti = el('input', 'input r-title'); ti.value = r.title; ti.maxLength = 60; ti.placeholder = 'Name this instruction'; ti.disabled = !!r.fixed; ti.oninput = () => changeRule(d => { d.title = ti.value; });
		box.append(ti);
		if (!r.fixed) { const di = el('input', 'input'); di.value = r.description || ''; di.maxLength = 160; di.placeholder = 'Short description (optional)'; di.oninput = () => changeRule(d => { d.description = di.value; }); box.append(di); }
		let placeAfter = null;
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
			if (state.ruleScopes.length > 1) { const pl = el('div', 'zpanel'); pl.append(el('div', 'zlabel', 'Where it lives')); pl.append(...placeChoices(state.ruleScopes, r.scope || 'project', key => { changeRule(d => { d.scope = key; }); renderRuleEdit(); })); placeAfter = pl; }
		}
		box.append(when);
		if (placeAfter) box.append(placeAfter);
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
		if (m.type === 'wizard') { openWizard(); return; }
		if (m.type === 'draftStatus') { if (wiz && wiz.busy) { wiz.note = m.text; renderWizard(); } return; }
		if (m.type === 'drafted') { if (wiz) { wiz.busy = false; wiz.draft = m.draft; wiz.picked = null; wiz.warn = !!m.note; wiz.note = m.note || (m.by === 'ai' ? 'Written by Lightchain AI. Change anything below, then create it.' : 'Drafted from your description. Change anything below, then create it.'); renderWizard(); } return; }
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
