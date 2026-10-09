import * as vscode from 'vscode';
import { LightchainNetwork, addressUrl, txUrl } from './networks';
import { NetworkState } from './networkState';

export type ProgramSource = 'foundry' | 'explorer' | 'manual';

export interface Program {
	address: `0x${string}`;
	name?: string;
	sources: ProgramSource[];
	txHash?: string;
	deployedAt?: number; // unix ms
}

interface Reference {
	uri: vscode.Uri;
	line: number;
	preview: string;
}

/** Everything remembered for one project on one network. */
interface ProjectNetworkState {
	manual: Program[];
	discovered: Program[]; // last explorer sync, so the list survives offline restarts
	deployer?: `0x${string}`;
	lastSync?: number;
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const MAX_SCAN_BYTES = 1_000_000;

type TreeNode = ProgramNode | ReferenceNode | OtherNode;

export class DeployedProgramsProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private programs: Program[] = [];
	private references = new Map<string, Reference[]>();
	private foundry: Program[] = [];
	private loading?: Promise<void>;
	private readonly disposables: vscode.Disposable[] = [];
	private rescanTimer?: ReturnType<typeof setTimeout>;
	view?: vscode.TreeView<TreeNode>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly network: NetworkState,
		private readonly deployerFallback: () => `0x${string}` | undefined,
	) {
		this.disposables.push(
			network.onDidChange(() => this.refresh()),
			vscode.workspace.onDidSaveTextDocument(() => this.scheduleRescan()),
			vscode.workspace.onDidCreateFiles(() => this.scheduleRescan()),
			vscode.workspace.onDidDeleteFiles(() => this.scheduleRescan()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
		);
		const broadcastWatcher = vscode.workspace.createFileSystemWatcher('**/broadcast/**/run-latest.json');
		this.disposables.push(
			broadcastWatcher,
			broadcastWatcher.onDidChange(() => this.refresh()),
			broadcastWatcher.onDidCreate(() => this.refresh()),
		);
	}

	// ---- state ---------------------------------------------------------------

	private stateKey(network = this.network.current): string {
		return `lightchain.programs.${network.id}`;
	}

	private get state(): ProjectNetworkState {
		return this.context.workspaceState.get<ProjectNetworkState>(this.stateKey(), { manual: [], discovered: [] });
	}

	private async saveState(update: Partial<ProjectNetworkState>): Promise<void> {
		await this.context.workspaceState.update(this.stateKey(), { ...this.state, ...update });
	}

	/** Programs this project names or references (the folded "Other deployments" are left out). */
	get relevant(): Program[] {
		return this.programs.filter(p => p.name || this.references.has(p.address.toLowerCase()));
	}

	get deployer(): `0x${string}` | undefined {
		return this.state.deployer ?? this.deployerFallback();
	}

	async setDeployer(address: `0x${string}` | undefined): Promise<void> {
		await this.saveState({ deployer: address, discovered: [], lastSync: undefined });
		await this.refresh();
	}

	async addManual(address: `0x${string}`, name?: string): Promise<void> {
		const manual = this.state.manual.filter(p => !sameAddress(p.address, address));
		manual.push({ address, name: name || undefined, sources: ['manual'] });
		await this.saveState({ manual });
		await this.refresh({ sync: false });
	}

	/** Name an unnamed program once its ABI identified it (e.g. by bytecode). */
	async rememberName(address: string, name: string): Promise<void> {
		const named = (list: Program[]) => list.map(p => sameAddress(p.address, address) && !p.name ? { ...p, name } : p);
		await this.saveState({ manual: named(this.state.manual), discovered: named(this.state.discovered) });
		await this.refresh({ sync: false });
	}

	async removeManual(address: string): Promise<void> {
		await this.saveState({ manual: this.state.manual.filter(p => !sameAddress(p.address, address)) });
		await this.refresh({ sync: false });
	}

	// ---- loading -------------------------------------------------------------

	refresh(opts: { sync?: boolean } = {}): Promise<void> {
		const run = async () => {
			const network = this.network.current;
			this.foundry = await readFoundryBroadcasts(network);
			this.rebuild();
			if (opts.sync !== false) {
				await this.syncExplorer(network);
			}
			await this.scanReferences();
		};
		this.loading = (this.loading ?? Promise.resolve()).then(run, run);
		return Promise.resolve(vscode.window.withProgress({ location: { viewId: 'lightchain.deployedPrograms' } }, () => this.loading!));
	}

	private async syncExplorer(network: LightchainNetwork): Promise<void> {
		const deployer = this.deployer;
		if (!deployer) {
			return;
		}
		try {
			const discovered = await fetchCreatedContracts(network, deployer);
			if (this.network.current.id === network.id) {
				await this.saveState({ discovered, lastSync: Date.now() });
				this.rebuild();
			}
		} catch (err) {
			// Keep the cached list; the explorer being unreachable shouldn't empty the view.
			this.setMessage(`Lightscan unreachable — showing last synced list. (${(err as Error).message})`);
		}
	}

	private rebuild(): void {
		const byAddress = new Map<string, Program>();
		const merge = (p: Program) => {
			const key = p.address.toLowerCase();
			const prev = byAddress.get(key);
			if (!prev) {
				byAddress.set(key, { ...p, sources: [...p.sources] });
				return;
			}
			prev.name ??= p.name;
			prev.txHash ??= p.txHash;
			prev.deployedAt ??= p.deployedAt;
			for (const s of p.sources) {
				if (!prev.sources.includes(s)) {
					prev.sources.push(s);
				}
			}
		};
		// Foundry first: it knows contract names.
		this.foundry.forEach(merge);
		this.state.manual.forEach(merge);
		this.state.discovered.forEach(merge);
		this.programs = [...byAddress.values()].sort((a, b) => (b.deployedAt ?? 0) - (a.deployedAt ?? 0));
		this.updateViewChrome();
		this._onDidChangeTreeData.fire();
	}

	private scheduleRescan(): void {
		clearTimeout(this.rescanTimer);
		this.rescanTimer = setTimeout(() => this.scanReferences().then(() => this._onDidChangeTreeData.fire()), 600);
	}

	/** Which program addresses appear anywhere in the project's files. */
	private async scanReferences(): Promise<void> {
		const wanted = new Set(this.programs.map(p => p.address.toLowerCase()));
		const refs = new Map<string, Reference[]>();
		if (wanted.size && vscode.workspace.workspaceFolders?.length) {
			const exclude = vscode.workspace.getConfiguration('lightchain.programs').get<string[]>('scanExclude', []);
			const files = await vscode.workspace.findFiles('**/*', exclude.length ? `{${exclude.join(',')}}` : undefined, 5000);
			const decoder = new TextDecoder();
			await Promise.all(files.map(async uri => {
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if (stat.size > MAX_SCAN_BYTES) {
						return;
					}
					const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
					if (text.includes('\u0000')) {
						return; // binary
					}
					const lines = text.split(/\r?\n/);
					lines.forEach((line, i) => {
						for (const match of line.matchAll(ADDRESS_RE)) {
							const key = match[0].toLowerCase();
							if (wanted.has(key)) {
								const list = refs.get(key) ?? [];
								list.push({ uri, line: i, preview: line.trim().slice(0, 120) });
								refs.set(key, list);
							}
						}
					});
				} catch {
					// unreadable file — skip
				}
			}));
		}
		this.references = refs;
		this.updateViewChrome();
		this._onDidChangeTreeData.fire();
	}

	private updateViewChrome(): void {
		if (!this.view) {
			return;
		}
		const used = this.programs.filter(p => this.references.has(p.address.toLowerCase())).length;
		this.view.description = this.network.current.label;
		this.view.badge = undefined;
		this.view.message = this.programs.length
			? `${this.programs.length} program${this.programs.length === 1 ? '' : 's'} · ${used} used in this project`
			: undefined;
	}

	private setMessage(message: string): void {
		if (this.view) {
			this.view.message = message;
		}
	}

	// ---- tree ----------------------------------------------------------------

	getTreeItem(node: TreeNode): vscode.TreeItem {
		return node;
	}

	getChildren(node?: TreeNode): (TreeNode)[] {
		const make = (p: Program) => new ProgramNode(p, this.network.current, this.references.get(p.address.toLowerCase()) ?? []);
		// unnamed contracts this project never mentions are rarely what you look for: keep them folded away
		const minor = (p: Program) => !p.name && !this.references.has(p.address.toLowerCase());
		if (!node) {
			const main = this.programs.filter(p => !minor(p)).map(make);
			const other = this.programs.filter(minor);
			return other.length ? [...main, new OtherNode(other.length, main.length === 0)] : main;
		}
		if (node instanceof OtherNode) {
			return this.programs.filter(minor).map(make);
		}
		if (node instanceof ProgramNode) {
			return node.refs.map(r => new ReferenceNode(r));
		}
		return [];
	}

	findReferences(address: string): Reference[] {
		return this.references.get(address.toLowerCase()) ?? [];
	}

	dispose(): void {
		clearTimeout(this.rescanTimer);
		this.disposables.forEach(d => d.dispose());
		this._onDidChangeTreeData.dispose();
	}
}

export class ProgramNode extends vscode.TreeItem {
	constructor(readonly program: Program, network: LightchainNetwork, readonly refs: Reference[]) {
		super(program.name ?? shortAddress(program.address), refs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		const used = refs.length > 0;
		this.id = `${network.id}:${program.address.toLowerCase()}`;
		this.description = program.name ? shortAddress(program.address) : undefined;
		this.iconPath = used
			? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
			: new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground'));
		this.contextValue = program.sources.length === 1 && program.sources[0] === 'manual' ? 'program.manual' : 'program';

		const md = new vscode.MarkdownString(undefined, true);
		md.appendMarkdown(`**${program.name ?? 'Contract'}** — ${network.label}\n\n`);
		md.appendMarkdown(`\`${program.address}\`\n\n`);
		md.appendMarkdown(`Source: ${program.sources.map(sourceLabel).join(', ')}\n\n`);
		if (program.deployedAt) {
			md.appendMarkdown(`Deployed: ${new Date(program.deployedAt).toLocaleString()}\n\n`);
		}
		md.appendMarkdown(used ? `$(pass-filled) Referenced in ${refs.length} place${refs.length === 1 ? '' : 's'}\n\n` : `$(circle-large-outline) Not referenced in this project\n\n`);
		md.appendMarkdown(`[Open on Lightscan](${addressUrl(network, program.address)})`);
		if (program.txHash) {
			md.appendMarkdown(` · [Deployment tx](${txUrl(network, program.txHash)})`);
		}
		this.tooltip = md;
		this.command = { command: 'lightchain.programs.openInExplorer', title: 'Open in Lightscan', arguments: [this] };
	}
}

class OtherNode extends vscode.TreeItem {
	constructor(count: number, expanded: boolean) {
		super('Other deployments', expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
		this.id = 'other-deployments';
		this.description = String(count);
		this.tooltip = 'Contracts deployed from your account that this project does not reference.';
		this.contextValue = 'otherDeployments';
	}
}

class ReferenceNode extends vscode.TreeItem {
	constructor(ref: Reference) {
		super(vscode.workspace.asRelativePath(ref.uri), vscode.TreeItemCollapsibleState.None);
		this.description = `:${ref.line + 1}  ${ref.preview}`;
		this.resourceUri = ref.uri;
		this.iconPath = vscode.ThemeIcon.File;
		this.contextValue = 'reference';
		this.command = {
			command: 'vscode.open',
			title: 'Open',
			arguments: [ref.uri, { selection: new vscode.Range(ref.line, 0, ref.line, 0) } satisfies vscode.TextDocumentShowOptions],
		};
	}
}

// ---- sources ---------------------------------------------------------------

/** Contracts created by Foundry scripts: broadcast/<Script>/<chainId>/run-latest.json */
async function readFoundryBroadcasts(network: LightchainNetwork): Promise<Program[]> {
	const files = await vscode.workspace.findFiles(`**/broadcast/**/${network.chainId}/run-latest.json`, '**/node_modules/**', 200);
	const programs: Program[] = [];
	const decoder = new TextDecoder();
	for (const uri of files) {
		try {
			const run = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri)));
			const timestamp = typeof run.timestamp === 'number' ? (run.timestamp < 1e12 ? run.timestamp * 1000 : run.timestamp) : undefined;
			for (const tx of run.transactions ?? []) {
				if ((tx.transactionType === 'CREATE' || tx.transactionType === 'CREATE2') && typeof tx.contractAddress === 'string') {
					programs.push({ address: tx.contractAddress, name: tx.contractName ?? undefined, txHash: tx.hash, deployedAt: timestamp, sources: ['foundry'] });
				}
				for (const extra of tx.additionalContracts ?? []) {
					if (typeof extra.address === 'string') {
						programs.push({ address: extra.address, name: extra.contractName ?? undefined, txHash: tx.hash, deployedAt: timestamp, sources: ['foundry'] });
					}
				}
			}
		} catch {
			// partial or malformed broadcast — ignore
		}
	}
	return programs;
}

/** Contracts the deployer created, from Lightscan (Blockscout etherscan-compatible API). */
async function fetchCreatedContracts(network: LightchainNetwork, deployer: string): Promise<Program[]> {
	const url = `${network.explorerUrl}/api?module=account&action=txlist&address=${deployer}&sort=desc&page=1&offset=1000`;
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	const body = await res.json() as { status?: string; message?: string; result?: unknown };
	if (!Array.isArray(body.result)) {
		if (body.message === 'No transactions found') {
			return [];
		}
		throw new Error(body.message ?? 'unexpected response');
	}
	return body.result
		.filter((tx: any) => !tx.to && typeof tx.contractAddress === 'string' && tx.contractAddress && tx.isError !== '1')
		.map((tx: any) => ({
			address: tx.contractAddress,
			txHash: tx.hash,
			deployedAt: tx.timeStamp ? Number(tx.timeStamp) * 1000 : undefined,
			sources: ['explorer'] as ProgramSource[],
		}));
}

// ---- helpers ---------------------------------------------------------------

export function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function sameAddress(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function sourceLabel(s: ProgramSource): string {
	return s === 'foundry' ? 'Foundry deployment' : s === 'explorer' ? 'Deployer address (Lightscan)' : 'Added manually';
}
