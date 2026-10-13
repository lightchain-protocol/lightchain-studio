import * as vscode from 'vscode';
import { encryptKeystore } from './keystore';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InteractPanels } from './interact';
import { DeployCodeLens, deployWizard } from './deployWizard';
import { SecurityWatch } from './chain/securityWatch';
import { GasLens } from './chain/gasLens';
import { describeFindings } from './chain/security';
import { ProjectAbis } from './chain/projectAbis';
import { TxPanel } from './chain/txPanel';
import { DashboardPanel } from './chain/dashboardPanel';
import { MapPanel } from './chain/mapPanel';
import { AppPanel } from './chain/appPanel';
import { showLauncher } from './launcher';
import { BackgroundAgents } from './backgroundRunner';
import { WalletSpaces } from './walletSpace';
import { JOB_FEE_LCAI } from './credits';
import { describeSimulation, simulate } from './chain/simulate';
import { findForge } from './foundry';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';
import { LightchainCodeActions } from './agent/quickFix';
import { setLog as setInferenceLog } from './lightchain/inference';
import { addressUrl } from './networks';
import { NetworkState } from './networkState';
import { Wallet, WalletAccount, isAddress } from './wallet';
import { BrowserBridge } from './browserBridge';
import { Credits, formatLcai } from './credits';
import { WalletView } from './walletView';
import { DeployedProgramsProvider, ProgramNode, shortAddress } from './deployedPrograms';
import { MarketplaceProvider, installEntry, openEntry } from './marketplace';
import { LightchainAiView } from './aiView';
import { StartPage } from './startPage';
import { PENDING_BUILD, PendingBuild, newProject, setPendingStore } from './newProject';
import { NewProjectPanel } from './newProjectPanel';
import { registerFoundry } from './foundry';
import { LightchainProvider } from './lightchain/provider';
import { EditorReview } from './editorReview';
import { TaskStore } from './tasks';
import { AgentProfiles } from './agent/profiles';
import { RuleStore, renderRules } from './agent/rules';
import { WorkspaceIndex } from './agent/workspaceIndex';
import { AgentStudio } from './agentStudio';
import { BoardPanel } from './boardPanel';
import { WorkspaceView } from './workspaceView';
import { commitWithAi } from './commitMessage';
import { InlinePrompt } from './inlinePrompt';
import { projectMap } from './agent/projectMap';
import { mentionItems, resolveMention, solidityFiles } from './agent/mentions';
import { watchFailures } from './failureWatcher';
import { ProposalStore, PROPOSAL_SCHEME } from './agent/proposals';

export function activate(context: vscode.ExtensionContext): void {
	const network = new NetworkState(context);
	const bridge = new BrowserBridge(context);
	const wallet = new Wallet(context, bridge);
	const credits = new Credits(wallet);
	const programs = new DeployedProgramsProvider(context, network, () => wallet.active?.address);
	const security = new SecurityWatch();
	const projectAbis = new ProjectAbis();
	const deployedNames = () => new Map(programs.relevant.filter(p => p.name).map(p => [p.address.toLowerCase(), p.name!]));
	const txPanel = new TxPanel(context.extensionUri, network, projectAbis, deployedNames, request => ai.ask(request));
	const dashboard = new DashboardPanel(context.extensionUri, network, projectAbis);
	const contractMapPanel = new MapPanel(context.extensionUri, () => solidityFiles(), () => programs.relevant, (request, file) => ai.ask(request, file), async file => (await security.findings(file)).filter(f => f.severity === 'high').length);
	const appPanel = new AppPanel(context.extensionUri, network, projectAbis, () => programs.relevant, (request, file) => ai.ask(request, file));
	// simulate before signing: what a transaction would change, tried on a private copy of the network
	wallet.preview = async (account, net, tx) => {
		const forge = findForge();
		const anvil = forge ? nodePath.join(nodePath.dirname(forge), process.platform === 'win32' ? 'anvil.exe' : 'anvil') : undefined;
		const abis = await projectAbis.index();
		const name = tx.to ? deployedNames().get(tx.to.toLowerCase()) ?? abis.decodeCall(tx.data)?.contract : undefined;
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking what this transaction will do…' }, async () =>
			describeSimulation(await simulate({ rpcUrl: net.rpcUrl, anvil: anvil && nodeFs.existsSync(anvil) ? anvil : undefined, abis, abi: name ? abis.byName(name)?.abi : undefined, toLabel: name, tx: { from: account.address, to: tx.to, data: tx.data, value: tx.value } })));
	};
	const gasLens = new GasLens(wallet, network);
	const marketplace = new MarketplaceProvider();
	const proposals = new ProposalStore();
	const aiLog = vscode.window.createOutputChannel('Lightchain AI', { log: true });
	setInferenceLog(line => aiLog.warn(line));
	context.subscriptions.push(aiLog);
	const interact = new InteractPanels(context, wallet, network, (address, name) => void programs.rememberName(address, name));
	context.subscriptions.push(interact, vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals));
	const review = new EditorReview();
	context.subscriptions.push(review);
	const ai = new LightchainAiView(context.extensionUri, wallet, network, credits, model => new LightchainProvider(wallet, network, model), proposals, context.globalState, context.workspaceState);

	ai.review = review;
	// lc-studio://lightchain.lightchain-studio/return — the wallet page's "Return to Lightchain Studio" button
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: uri => {
			if (uri.path === '/return') {
				void vscode.commands.executeCommand('lightchain.ai.focus');
			}
		},
	}));
	setPendingStore(context.globalState);
	// a project created with "Describe your app": let Lightchain AI shape it now that it is open
	const pending = context.globalState.get<PendingBuild>(PENDING_BUILD);
	const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (pending && here && pending.path === here) {
		void context.globalState.update(PENDING_BUILD, undefined);
		setTimeout(() => void ai.buildFromDescription(pending.description, pending.template), 1500);
	}
	const spaces = new WalletSpaces(context, wallet);
	context.subscriptions.push(spaces);
	const profiles = new AgentProfiles(() => spaces.dir, spaces.onDidChange);
	ai.profiles = profiles;
	const rules = new RuleStore(() => spaces.dir, spaces.onDidChange);
	const localIndex = new WorkspaceIndex();
	ai.rules = rules;
	ai.localSearch = async (query, exclude) => localIndex.enabled ? localIndex.search(query, exclude) : [];
	const studio = new AgentStudio(context.extensionUri, profiles, rules, localIndex, () => ai.modelNames(), (id, prompt) => ai.useAgent(id, prompt), () => ai.projectMap?.() ?? Promise.resolve(''), () => ai.sideProvider());
	context.subscriptions.push(profiles, rules, studio, profiles.onDidChange(() => ai.postAgents()),
		vscode.commands.registerCommand('lightchain.rules.open', (id?: string) => studio.open(undefined, 'rules', typeof id === 'string' ? id : undefined)),
		vscode.commands.registerCommand('lightchain.rules.new', () => studio.createRule()),
		vscode.commands.registerCommand('lightchain.agents.open', (id?: string) => studio.open(typeof id === 'string' ? id : undefined)),
		vscode.commands.registerCommand('lightchain.agents.new', () => studio.startNew()));
	const tasks = new TaskStore();
	ai.tasks = tasks;
	const background = new BackgroundAgents(context, tasks, () => ai.sideProvider(), () => profiles.get('builder'), JOB_FEE_LCAI);
	const board = new BoardPanel(context.extensionUri, tasks, t => ai.runTask(t), goal => ai.plan(goal), id => background.stateOf(id));
	context.subscriptions.push(background, background.onDidChange(() => board.refresh()),
		vscode.commands.registerCommand('lightchain.tasks.background', (id?: string) => background.start(typeof id === 'string' ? id : undefined)),
		vscode.commands.registerCommand('lightchain.tasks.backgroundMenu', () => background.menu()),
		vscode.commands.registerCommand('lightchain.tasks.backgroundReview', (id: string) => background.review(id)));
	const home = new WorkspaceView(context.extensionUri, ai, tasks);
	// Wallet spaces: a project belongs to the wallets that worked in it, and reopens with the one used last.
	const PROJECT_WALLET = 'lightchain.project.wallet';
	const projectFolder = vscode.workspace.workspaceFolders?.[0];
	const usedHere = context.workspaceState.get<string>(PROJECT_WALLET);
	if (projectFolder && usedHere && wallet.active && wallet.active.id !== usedHere && wallet.all.some(a => a.id === usedHere)) {
		void wallet.select(usedHere).then(() => vscode.window.setStatusBarMessage(`Switched to ${wallet.active?.name ?? 'the wallet'} — the wallet this project was last used with`, 6000));
	}
	const rememberProject = () => {
		if (projectFolder && wallet.active) {
			void context.workspaceState.update(PROJECT_WALLET, wallet.active.id);
			void spaces.remember(projectFolder.uri, projectFolder.name).then(() => home.refreshSoon());
		}
	};
	rememberProject();
	context.subscriptions.push(spaces.onDidChange(() => { rememberProject(); home.refreshSoon(); }), wallet.onDidChange(() => home.refreshSoon()));
	home.walletProjects = async () => wallet.active ? (await spaces.projects()).map(p => ({ label: p.name, detail: vscode.Uri.parse(p.path).fsPath.replace(/^\/Users\/[^/]+/, '~'), uri: p.path })) : undefined;
	home.wallets = () => wallet.all.map(a => ({ id: a.id, name: a.name, address: a.address, active: a.id === wallet.active?.id }));
	home.selectWallet = id => wallet.select(id);
	// "Your first dApp": build → test → deploy → interact → ask Lightchain AI
	const startKey = (k: string) => `lightchain.start.${k}`;
	const markStep = async (k: string) => { await context.workspaceState.update(startKey(k), true); home.refreshSoon(); ai.refreshState(); };
	home.account = async () => {
		const acc = wallet.active;
		if (!acc) {
			return undefined;
		}
		const snap = await credits.read(acc, network.current).catch(() => undefined);
		return { address: acc.address, network: network.current.label, credits: snap ? formatLcai(snap.credits) : undefined };
	};
	context.subscriptions.push(wallet.onDidChange(() => home.refreshSoon()), credits.onDidChange(() => home.refreshSoon()));
	// Explorer: connected wallets and Lightchain AI credits, read from the chain (replaces Outline/Timeline)
	const walletView = new WalletView(context.extensionUri, wallet, network, credits, context.globalState);
	context.subscriptions.push(walletView, vscode.window.registerWebviewViewProvider('lightchain.walletView', walletView));
		home.programs = () => {
		const shape = (p: { name?: string; address: string }) => ({ name: p.name, address: p.address, used: programs.findReferences(p.address).length > 0 });
		const relevant = programs.relevant;
		return { network: network.current.label, items: relevant.map(shape), other: programs.all.filter(p => !relevant.includes(p)).map(shape) };
	};
	context.subscriptions.push(vscode.commands.registerCommand('lightchain.programs.openAddress', (address: string) =>
		vscode.env.openExternal(vscode.Uri.parse(addressUrl(network.current, address)))), network.onDidChange(() => home.refreshSoon()));
	ai.startSteps = () => home.steps?.() ?? Promise.resolve(undefined);
	home.steps = async () => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		const exists = (p: string) => root ? Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, p))).then(() => true, () => false) : Promise.resolve(false);
		if (!root || context.workspaceState.get(startKey('dismissed')) || !(await exists('foundry.toml'))) {
			return undefined;
		}
		return [
			{ id: 'build', title: 'Build the contracts', sub: 'Compile them with Foundry', done: await exists('out'), command: 'lightchain.foundry.build', action: 'Build' },
			{ id: 'test', title: 'Run the tests', sub: 'Check the contract does what it should', done: !!context.workspaceState.get(startKey('test')), command: 'lightchain.foundry.test', action: 'Test' },
			{ id: 'deploy', title: 'Deploy to testnet', sub: 'Free test LCAI, nothing real at stake', done: programs.relevant.length > 0, command: 'lightchain.deployContract', action: 'Deploy' },
			{ id: 'interact', title: 'Call your contract', sub: 'Read and write it from the IDE', done: !!context.workspaceState.get(startKey('interact')), command: 'lightchain.start.interact', action: 'Open' },
			{ id: 'ask', title: 'Change it with Lightchain AI', sub: 'Describe a feature; review the edit', done: ai.chatList().length > 0, command: 'lightchain.ai.focus', action: 'Ask' },
		];
	};
	context.subscriptions.push(
		vscode.tasks.onDidEndTaskProcess(e => {
			const def = e.execution.task.definition;
			if (def.type === 'lightchain' && e.exitCode === 0) {
				if (def.task === 'Test') {
					void markStep('test');
				}
				home.refreshSoon();
				ai.refreshState();
			}
		}),
		programs.onDidChangeTreeData(() => { home.refreshSoon(); ai.refreshState(); }),
		vscode.commands.registerCommand('lightchain.start.dismiss', () => markStep('dismissed')),
		vscode.commands.registerCommand('lightchain.start.interact', async () => {
			const p = programs.relevant[programs.relevant.length - 1];
			if (!p) {
				vscode.window.showInformationMessage('Deploy a contract first, then call it from here.', 'Deploy').then(c => c && vscode.commands.executeCommand('lightchain.deployContract'));
				return;
			}
			await vscode.commands.executeCommand('lightchain.programs.interactAddress', p.address, p.name);
			await markStep('interact');
		}),
	);
	context.subscriptions.push(tasks, board, home,
		vscode.window.registerWebviewViewProvider('lightchain.workspace', home),
		vscode.commands.registerCommand('lightchain.ai.commit', () => commitWithAi(() => ai.sideProvider())),
		vscode.commands.registerCommand('lightchain.tasks.board', (id?: string) => board.open(typeof id === 'string' ? id : undefined)),
		vscode.commands.registerCommand('lightchain.tasks.add', async () => {
			const title = await vscode.window.showInputBox({ title: 'New task', placeHolder: 'What needs to be done?' });
			if (title?.trim()) {
				await tasks.add({ title });
			}
		}),
	);
	ai.inline = new InlinePrompt();
	ai.projectMap = async () => {
		const map = projectMap(await solidityFiles(), programs.relevant, network.current.label);
		await rules.ready();
		const always = renderRules(rules.always()).text;
		return [always && `Project instructions (written by the team — follow them):\n${always}`, map].filter(Boolean).join('\n\n');
	};
	ai.mentions = async () => [...rules.all.filter(r => r.apply !== 'always').map(r => ({ id: `rule:${r.id}`, label: r.title, detail: 'instruction', kind: 'rule' as const })), ...await mentionItems(programs.relevant)];
	context.subscriptions.push(watchFailures((command, output) => void ai.fixFailure(command, output)));
	ai.resolveMention = m => resolveMention(m, network.current, programs.relevant);
	context.subscriptions.push(ai.inline);
	const programsView = vscode.window.createTreeView('lightchain.deployedPrograms', { treeDataProvider: programs, showCollapseAll: true });
	programs.view = programsView;
	// The list stays folded while it is empty so Lightchain AI has the side bar; it opens once there is something to show.
	let known = 0;
	context.subscriptions.push(programs.onDidChangeTreeData(() => {
		const count = programs.relevant.length;
		if (!known && count && !programsView.visible) {
			void vscode.commands.executeCommand('lightchain.deployedPrograms.focus', { preserveFocus: true });
		}
		known = count;
	}));

	context.subscriptions.push(
		network, bridge, wallet, credits, programs, marketplace, ai, programsView,
		vscode.window.createTreeView('lightchain.marketplace', { treeDataProvider: marketplace }),
		vscode.window.registerWebviewViewProvider('lightchain.ai', ai),
		vscode.commands.registerCommand('lightchain.deployContract', (contractName?: string) => deployWizard(wallet, network, programs, typeof contractName === 'string' ? contractName : undefined, file => security.findings(file))),
		vscode.languages.registerCodeLensProvider({ language: 'solidity', scheme: 'file' }, new DeployCodeLens()),
		security, gasLens, projectAbis, txPanel, dashboard, contractMapPanel, appPanel,
		vscode.commands.registerCommand('lightchain.launcher', () => showLauncher(() => network.current.id)),
		vscode.commands.registerCommand('lightchain.app.preview', (target?: unknown) => appPanel.open((target as { program?: { address: `0x${string}`; name?: string } } | undefined)?.program)),
		vscode.commands.registerCommand('lightchain.tx.debug', (hash?: string) => txPanel.open(typeof hash === 'string' ? hash : undefined)),
		vscode.commands.registerCommand('lightchain.map.open', () => contractMapPanel.open()),
		vscode.commands.registerCommand('lightchain.dashboard.open', async (target?: unknown, name?: string) => {
			// from the Deployed contracts list (a node), from a panel (address, name), or picked
			const node = target as { program?: { address: `0x${string}`; name?: string } } | undefined;
			const chosen = typeof target === 'string' ? { address: target as `0x${string}`, name } : node?.program ?? await (async () => {
				const other = { label: '$(edit) Another address…', description: 'Any contract on this network', program: undefined };
				const pick = await vscode.window.showQuickPick([...programs.relevant.map(p => ({ label: p.name ?? p.address, description: p.name ? p.address : undefined, program: p as { address: `0x${string}`; name?: string } | undefined })), other], { title: 'Open a contract\'s dashboard', placeHolder: 'Pick a deployed contract' });
				if (pick !== other) {
					return pick?.program;
				}
				const address = await vscode.window.showInputBox({ title: 'Open a contract\'s dashboard', prompt: `Contract address on Lightchain ${network.current.label}`, placeHolder: '0x…', ignoreFocusOut: true, validateInput: v => /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? undefined : 'An address is 0x followed by 40 characters.' });
				return address ? { address: address.trim() as `0x${string}`, name: undefined } : undefined;
			})();
			if (chosen) {
				dashboard.open({ address: chosen.address, name: chosen.name });
			}
		}),
		vscode.languages.registerCodeLensProvider({ pattern: '**/src/**/*.sol', scheme: 'file' }, gasLens),
		vscode.commands.registerCommand('lightchain.gas.cheaper', (file: string, fn: string, gas?: number) => ai.ask(`Make ${fn}() in ${file} cheaper to call${gas ? ` (it costs about ${Math.round(gas).toLocaleString('en-US')} gas now)` : ''}. Explain each saving in plain words first, and do not change what it does.`, file)),
		vscode.commands.registerCommand('lightchain.security.fixAll', async (file?: string) => {
			const target = typeof file === 'string' ? file : vscode.window.activeTextEditor ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false) : undefined;
			const found = target ? await security.findings(target) : [];
			if (!target || !found.length) {
				vscode.window.showInformationMessage('The security check found nothing to fix in this file.');
				return;
			}
			await ai.ask(`Fix these security problems in ${target}, one by one, and say what you changed:\n${describeFindings(target, found)}`, target);
		}),
		vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new LightchainCodeActions(), { providedCodeActionKinds: LightchainCodeActions.kinds }),
		vscode.commands.registerCommand('lightchain.ai.fix', (uri: vscode.Uri, problems: { line: number; endLine: number; message: string }[]) => ai.fixProblems(uri, problems)),
		vscode.commands.registerCommand('lightchain.ai.askSelection', () => ai.askAboutSelection()),
		vscode.commands.registerCommand('lightchain.ai.inlineEdit', () => ai.inlineEdit()),
		vscode.commands.registerCommand('lightchain.ai.audit', (file?: string) => typeof file === 'string' && ai.audit(file)),
		// A new active account is the default deployer, so re-sync programs.
		wallet.onDidChange(() => programs.refresh()),
	);

	registerNetworkCommands(context, network);
	registerProgramCommands(context, programs, network, interact);
	registerWalletCommands(context, wallet, network, credits);
	registerStatusBar(context, wallet, network, credits);
	registerFoundry(context, wallet, network);

	context.subscriptions.push(
		vscode.commands.registerCommand('lightchain.marketplace.refresh', () => marketplace.refresh()),
		vscode.commands.registerCommand('lightchain.marketplace.install', installEntry),
		vscode.commands.registerCommand('lightchain.marketplace.open', openEntry),
	);

	const newProjectPanel = new NewProjectPanel(context.extensionUri);
	context.subscriptions.push(newProjectPanel);
	const start = new StartPage(context, newProject);
	context.subscriptions.push(
		start,
		vscode.commands.registerCommand('lightchain.start.open', () => start.show()),
		vscode.commands.registerCommand('lightchain.project.new', newProject),
		vscode.commands.registerCommand('lightchain.project.newPanel', () => newProjectPanel.open()),
	);
	start.maybeShowOnStartup();
	// First launch of a profile: open the Lightchain side bar (Deployed Programs + Lightchain AI).
	if (!context.globalState.get<boolean>('lightchain.sidebarShown')) {
		void context.globalState.update('lightchain.sidebarShown', true);
		void vscode.commands.executeCommand('workbench.view.extension.lightchain');
	}

	programs.refresh();
}

function registerNetworkCommands(context: vscode.ExtensionContext, network: NetworkState): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('lightchain.network.useMainnet', () => network.set('mainnet')),
		vscode.commands.registerCommand('lightchain.network.useTestnet', () => network.set('testnet')),
	);
}

function registerProgramCommands(context: vscode.ExtensionContext, programs: DeployedProgramsProvider, network: NetworkState, interact: InteractPanels): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('lightchain.programs.refresh', () => programs.refresh()),

		vscode.commands.registerCommand('lightchain.programs.add', async () => {
			const address = await vscode.window.showInputBox({
				title: `Add Contract — ${network.current.label}`,
				prompt: 'Contract address',
				placeHolder: '0x…',
				ignoreFocusOut: true,
				validateInput: v => isAddress(v.trim()) ? undefined : 'Enter a valid 0x address',
			});
			if (!address) {
				return;
			}
			const name = await vscode.window.showInputBox({ title: 'Add Contract', prompt: 'Name (optional)', placeHolder: 'e.g. Token, Vault', ignoreFocusOut: true });
			await programs.addManual(address.trim() as `0x${string}`, name?.trim());
		}),

		vscode.commands.registerCommand('lightchain.programs.setDeployer', async () => {
			const current = programs.deployer;
			const value = await vscode.window.showInputBox({
				title: `Deployer Address — ${network.current.label}`,
				prompt: 'Contracts created by this address are listed from Lightscan. Leave empty to use the active wallet account.',
				value: current ?? '',
				placeHolder: '0x…',
				ignoreFocusOut: true,
				validateInput: v => !v.trim() || isAddress(v.trim()) ? undefined : 'Enter a valid 0x address',
			});
			if (value === undefined) {
				return;
			}
			await programs.setDeployer(value.trim() ? value.trim() as `0x${string}` : undefined);
		}),

		vscode.commands.registerCommand('lightchain.programs.interact', (node: ProgramNode) => interact.open(node.program)),
		vscode.commands.registerCommand('lightchain.programs.interactAddress', (address: `0x${string}`, name?: string) => interact.open({ address, name, sources: ['manual'] })),

		vscode.commands.registerCommand('lightchain.programs.openInExplorer', (node: ProgramNode) =>
			vscode.env.openExternal(vscode.Uri.parse(addressUrl(network.current, node.program.address)))),

		vscode.commands.registerCommand('lightchain.programs.copyAddress', async (node: ProgramNode) => {
			await vscode.env.clipboard.writeText(node.program.address);
			vscode.window.setStatusBarMessage(`Copied ${shortAddress(node.program.address)}`, 2000);
		}),

		vscode.commands.registerCommand('lightchain.programs.findReferences', (node: ProgramNode) =>
			vscode.commands.executeCommand('workbench.action.findInFiles', { query: node.program.address, isCaseSensitive: false, triggerSearch: true })),

		vscode.commands.registerCommand('lightchain.programs.remove', (node: ProgramNode) => programs.removeManual(node.program.address)),
	);
}

function registerWalletCommands(context: vscode.ExtensionContext, wallet: Wallet, network: NetworkState, credits: Credits): void {
	const askName = (fallback: string) => vscode.window.showInputBox({ title: 'Account name', value: fallback, ignoreFocusOut: true });

	const create = async () => {
		const name = await askName(`Account ${wallet.accounts.length + 1}`);
		if (!name) {
			return;
		}
		const account = await wallet.create(name);
		vscode.window.showInformationMessage(`Created ${account.name} (${shortAddress(account.address)}). The key is stored in your OS keychain — export a backup from the wallet menu.`);
	};

	const importKey = async () => {
		const key = await vscode.window.showInputBox({ title: 'Import Private Key', prompt: 'The key is stored in your OS keychain and never leaves this machine.', password: true, ignoreFocusOut: true });
		if (!key) {
			return;
		}
		const name = await askName(`Imported ${wallet.accounts.length + 1}`);
		if (!name) {
			return;
		}
		try {
			const account = await wallet.importKey(name, key.trim());
			vscode.window.showInformationMessage(`Imported ${account.name} (${shortAddress(account.address)}).`);
		} catch (err) {
			vscode.window.showErrorMessage((err as Error).message);
		}
	};

	const importMnemonic = async () => {
		const phrase = await vscode.window.showInputBox({
			title: 'Import Recovery Phrase', prompt: '12 or 24 words separated by spaces. Only the derived account key is stored (in your OS keychain), not the phrase.',
			password: true, ignoreFocusOut: true,
			validateInput: v => !v.trim() || Wallet.mnemonicAddress(v) ? undefined : 'Not a valid recovery phrase yet',
		});
		if (!phrase) {
			return;
		}
		const indexes = [0, 1, 2, 3, 4].map(i => ({ label: `Account ${i + 1}`, description: Wallet.mnemonicAddress(phrase, i), detail: `m/44'/60'/0'/0/${i}`, index: i }));
		const pick = await vscode.window.showQuickPick(indexes, { title: 'Which account?', placeHolder: 'Wallets like MetaMask list these in the same order' });
		if (!pick) {
			return;
		}
		const name = await askName(`Imported ${wallet.accounts.length + 1}`);
		if (!name) {
			return;
		}
		try {
			const account = await wallet.importMnemonic(name, phrase, pick.index);
			vscode.window.showInformationMessage(`Imported ${account.name} (${shortAddress(account.address)}).`);
		} catch (err) {
			vscode.window.showErrorMessage((err as Error).message);
		}
	};

	const exportKeystore = async () => {
		const locals = wallet.accounts.map(a => ({ label: a.name, description: a.address, id: a.id }));
		if (!locals.length) {
			vscode.window.showInformationMessage('Only local accounts can be exported. Create or import one first.');
			return;
		}
		const pick = locals.length === 1 ? locals[0] : await vscode.window.showQuickPick(locals, { title: 'Export to Foundry Keystore' });
		if (!pick) {
			return;
		}
		const dir = path.join(os.homedir(), '.foundry', 'keystores');
		const keystoreName = await vscode.window.showInputBox({
			title: 'Export to Foundry Keystore', prompt: `Saved to ${dir}. Use it with: forge script … --account <name>`,
			value: pick.label.replace(/[^\w.-]+/g, '-').toLowerCase(), ignoreFocusOut: true,
			validateInput: v => /^[\w.-]+$/.test(v) ? undefined : 'Letters, digits, dot, dash and underscore only',
		});
		if (!keystoreName) {
			return;
		}
		const target = path.join(dir, keystoreName);
		if (fs.existsSync(target)) {
			const ok = await vscode.window.showWarningMessage(`A keystore named "${keystoreName}" already exists.`, { modal: true }, 'Replace');
			if (ok !== 'Replace') {
				return;
			}
		}
		const password = await vscode.window.showInputBox({ title: 'Keystore Password', prompt: 'Forge asks for this password when it signs.', password: true, ignoreFocusOut: true, validateInput: v => v.length >= 8 ? undefined : 'At least 8 characters' });
		if (!password) {
			return;
		}
		const again = await vscode.window.showInputBox({ title: 'Confirm Password', password: true, ignoreFocusOut: true });
		if (again !== password) {
			vscode.window.showErrorMessage('The passwords do not match.');
			return;
		}
		const key = await wallet.exportKey(pick.id);
		if (!key) {
			vscode.window.showErrorMessage(`The key for "${pick.label}" is missing from the keychain.`);
			return;
		}
		const json = await encryptKeystore(key as `0x${string}`, password);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, JSON.stringify(json), { mode: 0o600 });
		const copy = await vscode.window.showInformationMessage(`Saved Foundry keystore "${keystoreName}". Sign with: forge script <Script> --account ${keystoreName} --broadcast`, 'Copy Flag');
		if (copy) {
			await vscode.env.clipboard.writeText(`--account ${keystoreName}`);
		}
	};

	const pickAccount = async (title: string) => {
		const items = wallet.all.map(a => ({ label: a.name, description: a.address, detail: a.kind === 'browser' ? 'Browser wallet' : 'Local key', id: a.id }));
		return vscode.window.showQuickPick(items, { title });
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('lightchain.wallet.create', create),
		vscode.commands.registerCommand('lightchain.wallet.import', importKey),
		vscode.commands.registerCommand('lightchain.wallet.importMnemonic', importMnemonic),
		vscode.commands.registerCommand('lightchain.wallet.exportKeystore', exportKeystore),

		vscode.commands.registerCommand('lightchain.wallet.select', async () => {
			const pick = await pickAccount('Select Account');
			if (pick) {
				await wallet.select(pick.id);
			}
		}),

		vscode.commands.registerCommand('lightchain.wallet.copyAddress', async () => {
			if (wallet.active) {
				await vscode.env.clipboard.writeText(wallet.active.address);
				vscode.window.setStatusBarMessage('Address copied', 2000);
			}
		}),

		vscode.commands.registerCommand('lightchain.wallet.exportKey', async () => {
			const locals = wallet.accounts.map(a => ({ label: a.name, description: a.address, id: a.id }));
			const pick = await vscode.window.showQuickPick(locals, { title: 'Export Private Key' });
			if (!pick) {
				return;
			}
			const ok = await vscode.window.showWarningMessage(
				`Export the private key of "${pick.label}"?`,
				{ modal: true, detail: 'Anyone with this key controls the account and its funds on every network. It will be copied to your clipboard.' },
				'Copy Private Key');
			if (ok) {
				const key = await wallet.exportKey(pick.id);
				if (key) {
					await vscode.env.clipboard.writeText(key);
					vscode.window.showInformationMessage('Private key copied. Clear your clipboard after saving it.');
				}
			}
		}),

		vscode.commands.registerCommand('lightchain.wallet.remove', async () => {
			const pick = await pickAccount('Remove Account');
			if (!pick) {
				return;
			}
			const ok = await vscode.window.showWarningMessage(
				`Remove "${pick.label}" from Lightchain Studio?`,
				{ modal: true, detail: 'The private key is deleted from this machine. Export it first if you have not backed it up.' },
				'Remove');
			if (ok) {
				await wallet.remove(pick.id);
			}
		}),

		vscode.commands.registerCommand('lightchain.wallet.connectBrowser', async () => {
			try {
				const account = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Connect your wallet in the browser tab that just opened…', cancellable: true },
					(_p, token) => new Promise<WalletAccount>((resolve, reject) => {
						token.onCancellationRequested(() => reject(new Error('Cancelled.')));
						wallet.connectBrowser().then(resolve, reject);
					}));
				vscode.window.showInformationMessage(`Connected ${account.name} (${shortAddress(account.address)}).`);
			} catch (err) {
				if ((err as Error).message !== 'Cancelled.') {
					vscode.window.showErrorMessage((err as Error).message);
				}
			}
		}),

		vscode.commands.registerCommand('lightchain.credits.topUp', async () => {
			const account = wallet.active;
			if (!account) {
				return vscode.commands.executeCommand('lightchain.wallet.menu');
			}
			const net = network.current;
			const amount = await vscode.window.showInputBox({
				title: `Top Up Credits — ${net.label}`,
				prompt: 'LCAI to deposit as Lightchain AI credits (JobRegistry prepaid balance — withdraw any time).',
				placeHolder: '1',
				ignoreFocusOut: true,
				validateInput: v => /^\d+(\.\d{1,18})?$/.test(v.trim()) && Number(v) > 0 ? undefined : 'Enter an LCAI amount, e.g. 1 or 0.5',
			});
			if (!amount) {
				return;
			}
			if (net.id === 'mainnet') {
				const ok = await vscode.window.showWarningMessage(`Deposit ${amount} LCAI on Lightchain Mainnet?`, { modal: true, detail: `From ${account.address}. This is real LCAI.` }, 'Deposit');
				if (!ok) {
					return;
				}
			}
			await runTx(`Depositing ${amount} LCAI as credits…`, account.kind, () => credits.topUp(account, net, amount.trim()), net);
		}),

		vscode.commands.registerCommand('lightchain.credits.withdraw', async () => {
			const account = wallet.active;
			if (!account) {
				return;
			}
			const net = network.current;
			const snap = await credits.read(account, net);
			const amount = await vscode.window.showInputBox({
				title: `Withdraw Credits — ${net.label}`,
				prompt: `Available: ${formatLcai(snap.credits, 18)} LCAI`,
				value: formatLcai(snap.credits, 18).replace(/,/g, ''),
				ignoreFocusOut: true,
				validateInput: v => /^\d+(\.\d{1,18})?$/.test(v.trim()) && Number(v) > 0 ? undefined : 'Enter an LCAI amount',
			});
			if (amount) {
				await runTx(`Withdrawing ${amount} LCAI…`, account.kind, () => credits.withdraw(account, net, amount.trim()), net);
			}
		}),

		vscode.commands.registerCommand('lightchain.wallet.openPage', () => wallet.openBridgePage()),
		vscode.commands.registerCommand('lightchain.wallet.disconnect', () => wallet.remove('browser')),

		vscode.commands.registerCommand('lightchain.wallet.menu', async () => {
			type Item = vscode.QuickPickItem & { run?: () => unknown };
			const items: Item[] = [];
			if (wallet.active) {
				items.push(
					{ label: `$(account) ${wallet.active.name}`, description: wallet.active.address, detail: 'Active account', run: () => vscode.commands.executeCommand('lightchain.wallet.copyAddress') },
					{ label: '', kind: vscode.QuickPickItemKind.Separator },
				);
				items.push(
					{ label: '$(add) Top Up Credits', description: 'Deposit LCAI for Lightchain AI', run: () => vscode.commands.executeCommand('lightchain.credits.topUp') },
					{ label: '$(arrow-down) Withdraw Credits', run: () => vscode.commands.executeCommand('lightchain.credits.withdraw') },
				);
				if (wallet.all.length > 1) {
					items.push({ label: '$(arrow-swap) Switch Account', run: () => vscode.commands.executeCommand('lightchain.wallet.select') });
				}
				if (wallet.active.kind === 'browser') {
					items.push({ label: '$(debug-disconnect) Disconnect Wallet', run: () => vscode.commands.executeCommand('lightchain.wallet.disconnect') });
				}
				items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
			}
			items.push(
				{ label: '$(add) Create Account', run: create },
				{ label: '$(key) Import Private Key', run: importKey },
				{ label: '$(symbol-key) Import Recovery Phrase', run: importMnemonic },
				{ label: '$(plug) Connect Browser Wallet', description: 'MetaMask, Rabby, Coinbase, Brave…', run: () => vscode.commands.executeCommand('lightchain.wallet.connectBrowser') },
			);
			if (wallet.accounts.length) {
				items.push(
					{ label: '$(copy) Copy Address', run: () => vscode.commands.executeCommand('lightchain.wallet.copyAddress') },
					{ label: '$(export) Export Private Key…', run: () => vscode.commands.executeCommand('lightchain.wallet.exportKey') },
					{ label: '$(file-symlink-file) Export to Foundry Keystore…', description: 'forge script --account', run: exportKeystore },
					{ label: '$(trash) Remove Account…', run: () => vscode.commands.executeCommand('lightchain.wallet.remove') },
				);
			}
			const pick = await vscode.window.showQuickPick(items, { title: 'Lightchain Wallet' });
			await pick?.run?.();
		}),
	);
}

async function runTx(title: string, kind: 'local' | 'browser', send: () => Promise<string>, net: { explorerUrl: string }): Promise<void> {
	try {
		const hash = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: kind === 'browser' ? `${title} Approve in your browser wallet.` : title }, send);
		const open = await vscode.window.showInformationMessage(`Confirmed: ${hash.slice(0, 10)}…`, 'View on Lightscan');
		if (open) {
			vscode.env.openExternal(vscode.Uri.parse(`${net.explorerUrl}/tx/${hash}`));
		}
	} catch (err) {
		vscode.window.showErrorMessage((err as Error).message);
	}
}

function registerStatusBar(context: vscode.ExtensionContext, wallet: Wallet, network: NetworkState, credits: Credits): void {
	const item = vscode.window.createStatusBarItem('lightchain.wallet', vscode.StatusBarAlignment.Left, 100);
	item.name = 'Lightchain Wallet';
	item.command = 'lightchain.wallet.menu';
	context.subscriptions.push(item);

	let generation = 0;
	const update = async () => {
		const gen = ++generation;
		const account = wallet.active;
		const net = network.current;
		if (!account) {
			item.text = `$(key) Connect Wallet · ${net.label}`;
			item.tooltip = 'Create or import a Lightchain account';
			item.backgroundColor = undefined;
			item.show();
			return;
		}
		item.text = `$(key) ${shortAddress(account.address)} · ${net.label}`;
		item.tooltip = `${account.name}\n${account.address}\nLightchain ${net.label} (chain ${net.chainId})`;
		item.backgroundColor = net.id === 'mainnet' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		item.show();
		try {
			const snap = await credits.read(account, net);
			if (gen === generation) {
				// credits are shown in the Lightchain AI panel; the tooltip keeps the details
				item.tooltip = `${account.name}\n${account.address}\nWallet: ${formatLcai(snap.walletBalance)} LCAI\nLightchain AI credits: ${formatLcai(snap.credits)} LCAI\nLightchain ${net.label} (chain ${net.chainId})`;
			}
		} catch {
			// RPC unreachable: keep the address-only label
		}
	};

	context.subscriptions.push(wallet.onDidChange(update), network.onDidChange(update), credits.onDidChange(update));
	update();
}

export function deactivate(): void { }
