import * as vscode from 'vscode';
import type { Abi } from 'viem';
import { AbiIndex, KnownContract } from './abiIndex';

/** The project's ABIs (Foundry artifacts in out/), re-read when a build changes them. */
export class ProjectAbis implements vscode.Disposable {
	private cached?: Promise<AbiIndex>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'out/**/*.json'));
			const drop = () => { this.cached = undefined; };
			this.disposables.push(w, w.onDidChange(drop), w.onDidCreate(drop), w.onDidDelete(drop));
		}
	}

	index(): Promise<AbiIndex> {
		return this.cached ??= this.read();
	}

	private async read(): Promise<AbiIndex> {
		const uris = await vscode.workspace.findFiles('**/out/**/*.json', '{**/node_modules/**,**/build-info/**}', 3000);
		const contracts: KnownContract[] = [];
		// the project's own contracts first, so they win when a selector is shared with a library
		const own = (u: vscode.Uri) => /\/out\/[^/]+\.sol\/[^/]+\.json$/.test(u.path) && !/\.(t|s)\.sol\//.test(u.path) ? 0 : 1;
		await Promise.all(uris.sort((a, b) => own(a) - own(b)).map(async uri => {
			try {
				const a = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as { abi?: Abi; ast?: { absolutePath?: string } };
				if (Array.isArray(a.abi) && a.abi.length) {
					contracts.push({ name: uri.path.split('/').pop()!.replace(/\.json$/, ''), abi: a.abi, source: a.ast?.absolutePath });
				}
			} catch { /* not an artifact */ }
		}));
		return new AbiIndex(contracts.sort((a, b) => Number(!/^src\//.test(a.source ?? '')) - Number(!/^src\//.test(b.source ?? ''))));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
