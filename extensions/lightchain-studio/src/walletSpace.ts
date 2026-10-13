import * as vscode from 'vscode';
import { Wallet } from './wallet';

/**
 * A wallet's own space. Each wallet keeps, apart from every other wallet:
 * its list of projects, its personal agents and instructions (used in all of
 * its projects, next to what a project shares through git), its chats and its
 * choice of model and agent. Switching wallets switches all of it.
 *
 * Stored on this machine under the extension's storage, one folder per address:
 *   wallets/<address>/agents/*.md · rules/*.md · projects.json
 */
export interface SpaceProject { path: string; name: string; last: number }

/** Adds or refreshes a project in a wallet's list (newest first, at most `max`). */
export function touchProject(list: SpaceProject[], entry: SpaceProject, max = 30): SpaceProject[] {
	return [entry, ...list.filter(p => p.path !== entry.path)].sort((a, b) => b.last - a.last).slice(0, max);
}

export class WalletSpaces implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when another wallet becomes the active one (not on balance or name changes). */
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private last?: string;

	constructor(private readonly context: vscode.ExtensionContext, private readonly wallet: Wallet) {
		this.last = this.address;
		this.disposables.push(wallet.onDidChange(() => {
			if (this.address !== this.last) {
				this.last = this.address;
				this.changed.fire();
			}
		}));
	}

	/** The active wallet's address, lower-case; undefined when no wallet is connected. */
	get address(): string | undefined {
		return this.wallet.active?.address.toLowerCase();
	}

	/** A storage key that belongs to the active wallet (the plain key without a wallet). */
	key(name: string): string {
		return this.address ? `${name}:${this.address}` : name;
	}

	/** The active wallet's folder. */
	get dir(): vscode.Uri | undefined {
		return this.address ? vscode.Uri.joinPath(this.context.globalStorageUri, 'wallets', this.address) : undefined;
	}

	private get projectsFile(): vscode.Uri | undefined {
		return this.dir && vscode.Uri.joinPath(this.dir, 'projects.json');
	}

	async projects(): Promise<SpaceProject[]> {
		const file = this.projectsFile;
		if (!file) {
			return [];
		}
		try {
			const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
			return Array.isArray(raw) ? raw.filter(p => p && typeof p.path === 'string').map(p => ({ path: p.path, name: String(p.name ?? p.path.split('/').pop()), last: Number(p.last) || 0 })) : [];
		} catch {
			return [];
		}
	}

	private async save(list: SpaceProject[]): Promise<void> {
		const file = this.projectsFile;
		if (file && this.dir) {
			await vscode.workspace.fs.createDirectory(this.dir);
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(list, null, '\t') + '\n'));
		}
	}

	/** The open project now belongs to the active wallet's list. */
	async remember(folder: vscode.Uri | undefined, name?: string): Promise<void> {
		if (folder && this.dir) {
			await this.save(touchProject(await this.projects(), { path: folder.toString(), name: name ?? folder.path.split('/').pop() ?? 'project', last: Date.now() }));
		}
	}

	async forget(path: string): Promise<void> {
		await this.save((await this.projects()).filter(p => p.path !== path));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
