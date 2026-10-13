import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { findForge } from '../foundry';
import { NetworkState } from '../networkState';
import { Wallet } from '../wallet';
import { GasEstimates, gasLines } from './gas';

/**
 * Gas lens: above each contract and external function in src/, what it costs
 * on the current network. Estimates come from forge (run when a file is opened
 * or saved, never while typing) and the network's gas price.
 */
export class GasLens implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private estimates = new Map<string, { saved: number; now: Record<string, GasEstimates>; before: Record<string, GasEstimates> }>();
	private running = new Set<string>();
	private price?: { network: string; wei: bigint; at: number };

	constructor(private readonly wallet: Wallet, private readonly network: NetworkState) {
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(d => { if (this.applies(d)) { void this.refresh(d, true); } }),
			network.onDidChange(() => { this.price = undefined; this.changed.fire(); }),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('lightchain.gas')) { this.changed.fire(); } }),
		);
	}

	private applies(doc: vscode.TextDocument): boolean {
		return doc.uri.scheme === 'file' && /(^|\/)src\/.*\.sol$/.test(vscode.workspace.asRelativePath(doc.uri, false));
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.applies(doc) || !vscode.workspace.getConfiguration('lightchain.gas').get<boolean>('lens', true)) {
			return [];
		}
		const entry = this.estimates.get(doc.uri.toString());
		if (!entry) {
			void this.refresh(doc, false);
			return [];
		}
		const file = vscode.workspace.asRelativePath(doc.uri, false);
		// estimates describe the saved file; while it has unsaved edits, lines may have moved
		return doc.isDirty ? [] : gasLines(doc.getText(), entry.now, this.price?.wei, entry.before).map(l => new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), l.kind === 'call'
			? { title: `$(flame) ${l.title}`, tooltip: 'Ask Lightchain AI to make this cheaper', command: 'lightchain.gas.cheaper', arguments: [file, l.name, l.gas] }
			: { title: `$(flame) ${l.title}`, command: '' }));
	}

	private forge(root: string, args: string[]): Promise<string | undefined> {
		const forge = findForge();
		if (!forge) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => execFile(forge, args, { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout)));
	}

	private async refresh(doc: vscode.TextDocument, saved: boolean): Promise<void> {
		const key = doc.uri.toString();
		const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
		if (!root || this.running.has(key)) {
			return;
		}
		this.running.add(key);
		try {
			const file = vscode.workspace.asRelativePath(doc.uri, false);
			const names = [...doc.getText().matchAll(/^[ \t]*(?:abstract\s+)?contract\s+(\w+)/gm)].map(m => m[1]);
			const now: Record<string, GasEstimates> = {};
			for (const name of names) {
				const out = await this.forge(root, ['inspect', `${file}:${name}`, 'gasEstimates', '--json']);
				try {
					const parsed = out ? JSON.parse(out.slice(out.indexOf('{'))) as GasEstimates : undefined;
					if (parsed?.external || parsed?.creation) {
						now[name] = parsed;
					}
				} catch { /* does not compile right now: no lens */ }
			}
			const had = this.estimates.get(key);
			// "since last build" compares with the estimates before this save
			this.estimates.set(key, { saved: Date.now(), now, before: saved && had ? had.now : had?.before ?? {} });
			await this.gasPrice();
			this.changed.fire();
		} finally {
			this.running.delete(key);
		}
	}

	private async gasPrice(): Promise<void> {
		const net = this.network.current;
		if (this.price && this.price.network === net.id && Date.now() - this.price.at < 5 * 60_000) {
			return;
		}
		try {
			this.price = { network: net.id, wei: await this.wallet.publicClient(net).getGasPrice(), at: Date.now() };
		} catch { /* offline: gas only */ }
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
