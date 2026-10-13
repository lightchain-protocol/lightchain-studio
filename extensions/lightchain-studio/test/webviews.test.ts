import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { LightchainAiView } from '../src/aiView';
import { StartPage } from '../src/startPage';
import { InteractPanels } from '../src/interact';
import { connectPageHtml } from '../src/connectPage';
import { WorkspaceView } from '../src/workspaceView';
import { BoardPanel } from '../src/boardPanel';
import { AgentStudio } from '../src/agentStudio';
import { NewProjectPanel } from '../src/newProjectPanel';
import { WalletView } from '../src/walletView';

// The webview pages are HTML built in TypeScript template literals; a backslash that
// is right in TS can be wrong in the page (e.g. '\n' becomes a real line break inside
// a string). Compile every inline script so such a page can never ship.
const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u } as never;
const stub = { onDidChange: () => ({ dispose() { } }), current: { id: 'testnet', label: 'Testnet' }, active: undefined } as never;
const memento = { get: (_k: string, d?: unknown) => d, update: async () => { } } as never;
const extUri = { fsPath: '/ext', path: '/ext', toString: () => '/ext' } as never;

function scriptsOf(html: string): string[] {
	return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
}

function assertCompiles(name: string, html: string) {
	const scripts = scriptsOf(html);
	assert.ok(scripts.length > 0, `${name}: no inline script found`);
	for (const s of scripts) {
		assert.doesNotThrow(() => new vm.Script(s, { filename: `${name}.js` }), `${name}: inline script does not compile`);
	}
}

test('Lightchain AI panel script compiles', () => {
	const view = new LightchainAiView(extUri, stub, stub, stub, () => stub, stub, memento, memento) as unknown as { html(w: unknown): string };
	assertCompiles('aiView', view.html(webview));
});

test('Start page script compiles', () => {
	const page = new StartPage({ extensionUri: extUri } as never, async () => { }) as unknown as { html(w: unknown, r: unknown[]): string };
	assertCompiles('startPage', page.html(webview, [{ label: 'demo', detail: '/tmp/demo', uri: 'file:///tmp/demo' }]));
});

test('Interact tab script compiles', () => {
	const panels = new InteractPanels({ extensionUri: extUri } as never, stub, stub, () => { }) as unknown as { html(w: unknown, d: unknown): string };
	assertCompiles('interact', panels.html(webview, { name: 'C', address: '0x0', network: 'Testnet', explorer: 'https://x', source: 'test', functions: [] }));
});

test('Wallet connect page script compiles', () => {
	assertCompiles('connectPage', connectPageHtml({ nonce: 'n', networks: [], known: { address: '0x0', wallet: 'MetaMask' } }));
});

test('Lightchain sidebar (projects, tasks, chats) script compiles', () => {
	const host = { onDidChangeChats: () => ({ dispose() { } }) } as never;
	const tasks = { onDidChange: () => ({ dispose() { } }) } as never;
	const v = new WorkspaceView(extUri, host, tasks) as unknown as { html(w: unknown): string };
	assertCompiles('workspaceView', v.html(webview));
});

test('Wallet view script compiles', () => {
	const v = new WalletView(extUri, stub, stub, stub, memento) as unknown as { html(w: unknown): string };
	assertCompiles('walletView', v.html(webview));
});

test('Task board script compiles', () => {
	const tasks = { onDidChange: () => ({ dispose() { } }) } as never;
	const b = new BoardPanel(extUri, tasks, async () => { }, async () => { }) as unknown as { html(w: unknown): string };
	assertCompiles('boardPanel', b.html(webview));
});

test('Agent Studio script compiles', () => {
	const profiles = { onDidChange: () => ({ dispose() { } }) } as never;
	const st = new AgentStudio(extUri, profiles, () => [], async () => { }) as unknown as { html(w: unknown): string };
	assertCompiles('agentStudio', st.html(webview));
});

test('New project window script compiles', () => {
	const panel = new NewProjectPanel(extUri) as unknown as { html(w: unknown): string };
	assertCompiles('newProjectPanel', panel.html(webview));
});
