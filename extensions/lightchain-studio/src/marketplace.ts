import * as vscode from 'vscode';

/**
 * "Lightchain Marketplace" section in the Extensions view. Lists Lightchain's
 * own extensions plus curated picks; installs go through the regular gallery
 * (Open VSX), so any VS Code extension still works for those who want it.
 *
 * The catalog is JSON so it can later be served by a Lightchain registry
 * (`lightchain.marketplace.catalogUrl`); until then the bundled one is used.
 */
interface CatalogEntry {
	id: string; // publisher.name
	name: string;
	description: string;
	tier: 'official' | 'recommended';
}

interface Catalog {
	entries: CatalogEntry[];
}

const BUNDLED_CATALOG: Catalog = {
	entries: [
		{ id: 'lightchain.lightchain-studio', name: 'Lightchain Studio', description: 'Deployed programs, wallet and Lightchain AI', tier: 'official' },
		{ id: 'lightchain.theme-lightchain', name: 'Lightchain Themes', description: 'Official Lightchain color themes', tier: 'official' },
		// Verified on open-vsx.org 2026-10-01.
		{ id: 'NomicFoundation.hardhat-solidity', name: 'Solidity (Nomic Foundation)', description: 'Solidity language support, Foundry & Hardhat aware', tier: 'recommended' },
		{ id: 'JuanBlanco.solidity', name: 'Solidity (Juan Blanco)', description: 'Solidity compile, lint and snippets', tier: 'recommended' },
		{ id: 'tamasfe.even-better-toml', name: 'Even Better TOML', description: 'foundry.toml editing support', tier: 'recommended' },
	],
};

type Node = TierNode | EntryNode;

export class MarketplaceProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private catalog: Catalog = BUNDLED_CATALOG;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(vscode.extensions.onDidChange(() => this._onDidChangeTreeData.fire()));
	}

	async refresh(): Promise<void> {
		const url = vscode.workspace.getConfiguration('lightchain.marketplace').get<string>('catalogUrl');
		if (url) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
				const remote = await res.json() as Catalog;
				if (Array.isArray(remote.entries)) {
					this.catalog = remote;
				}
			} catch (err) {
				vscode.window.showWarningMessage(`Lightchain marketplace unreachable, showing bundled catalog. (${(err as Error).message})`);
				this.catalog = BUNDLED_CATALOG;
			}
		} else {
			this.catalog = BUNDLED_CATALOG;
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(node: Node): vscode.TreeItem {
		return node;
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return [new TierNode('official', 'Official'), new TierNode('recommended', 'Recommended for Lightchain')];
		}
		if (node instanceof TierNode) {
			return this.catalog.entries.filter(e => e.tier === node.tier).map(e => new EntryNode(e));
		}
		return [];
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this._onDidChangeTreeData.dispose();
	}
}

class TierNode extends vscode.TreeItem {
	constructor(readonly tier: CatalogEntry['tier'], label: string) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.iconPath = new vscode.ThemeIcon(tier === 'official' ? 'verified-filled' : 'star-full');
		this.contextValue = 'marketplace.tier';
	}
}

class EntryNode extends vscode.TreeItem {
	constructor(readonly entry: CatalogEntry) {
		super(entry.name, vscode.TreeItemCollapsibleState.None);
		const installed = !!vscode.extensions.getExtension(entry.id);
		this.description = installed ? `Installed · ${entry.description}` : entry.description;
		this.tooltip = `${entry.name}\n${entry.id}\n\n${entry.description}`;
		this.iconPath = new vscode.ThemeIcon(installed ? 'check' : 'extensions');
		this.contextValue = installed ? 'marketplace.installed' : 'marketplace.notInstalled';
		this.command = { command: 'lightchain.marketplace.open', title: 'Show Extension', arguments: [this] };
	}
}

export async function installEntry(node: EntryNode): Promise<void> {
	await vscode.commands.executeCommand('workbench.extensions.installExtension', node.entry.id);
}

export async function openEntry(node: EntryNode): Promise<void> {
	await vscode.commands.executeCommand('extension.open', node.entry.id);
}
