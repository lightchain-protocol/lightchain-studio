import * as vscode from 'vscode';

/**
 * The launcher behind the title bar's search box: what you can do in Lightchain
 * Studio, in plain words and grouped by intent, instead of a list of editor
 * modes. Typing filters the actions; anything else is offered as a file search,
 * and every editor command stays one item away.
 */
interface Entry extends vscode.QuickPickItem { command?: string; args?: unknown[] }

const ACTIONS: (Entry | { group: string })[] = [
	{ group: 'Ask' },
	{ label: '$(sparkle) Ask Lightchain AI', description: 'Describe what you want to build or change', command: 'lightchain.ai.focus' },
	{ label: '$(person-add) Make a new agent', description: 'A helper with one job, in your own words', command: 'lightchain.agents.new' },
	{ label: '$(organization) Agents and instructions', description: 'See and change how Lightchain AI works here', command: 'lightchain.agents.open' },
	{ group: 'Build' },
	{ label: '$(add) New project', description: 'Start from an idea or a template', command: 'lightchain.project.new' },
	{ label: '$(tools) Build the contracts', description: 'Check that everything compiles', command: 'lightchain.foundry.build' },
	{ label: '$(beaker) Run the tests', command: 'lightchain.foundry.test' },
	{ label: '$(rocket) Deploy a contract', description: 'Put it on Lightchain, testnet first', command: 'lightchain.deployContract' },
	{ group: 'Understand' },
	{ label: '$(type-hierarchy) Contract map', description: 'Who can do what, and where money moves', command: 'lightchain.map.open' },
	{ label: '$(bug) Debug a transaction', description: 'What it did and why it failed', command: 'lightchain.tx.debug' },
	{ label: '$(pulse) Watch a deployed contract', description: 'Balance, values and events, live', command: 'lightchain.dashboard.open' },
	{ label: '$(browser) Make an app for a contract', description: 'A web page people can use it from', command: 'lightchain.app.preview' },
	{ label: '$(shield) Fix security problems', description: 'In the file you have open', command: 'lightchain.security.fixAll' },
	{ group: 'Project' },
	{ label: '$(checklist) Task board', command: 'lightchain.tasks.board' },
	{ label: '$(key) Wallet', description: 'Accounts and credits', command: 'lightchain.wallet.menu' },
	{ group: 'Go to' },
	{ label: '$(file) Open a file…', description: 'By name', command: 'workbench.action.quickOpen' },
	{ label: '$(search) Search in all files…', command: 'workbench.action.findInFiles' },
	{ label: '$(terminal) Every command…', description: 'The full list, for power users', command: 'workbench.action.showCommands' },
];

export function launcherItems(network: string): Entry[] {
	const items: Entry[] = [];
	for (const a of ACTIONS) {
		items.push('group' in a ? { label: a.group, kind: vscode.QuickPickItemKind.Separator } : a);
		if (!('group' in a) && a.command === 'lightchain.wallet.menu') {
			items.push(network === 'mainnet'
				? { label: '$(arrow-swap) Switch to testnet', description: 'Free test LCAI, nothing real at stake', command: 'lightchain.network.useTestnet' }
				: { label: '$(arrow-swap) Switch to mainnet', description: 'Real LCAI', command: 'lightchain.network.useMainnet' });
		}
	}
	return items;
}

export function showLauncher(network: () => string): void {
	const pick = vscode.window.createQuickPick<Entry>();
	const base = launcherItems(network());
	pick.placeholder = 'What do you want to do? Type an action or a file name';
	pick.matchOnDescription = true;
	pick.items = base;
	pick.onDidChangeValue(value => {
		const text = value.trim();
		// whatever is typed can also be a file: offer the search without leaving the launcher
		pick.items = text ? [...base, { label: 'Files', kind: vscode.QuickPickItemKind.Separator }, { label: `$(file) Find a file named "${text}"`, alwaysShow: true, command: 'workbench.action.quickOpen', args: [text] }] : base;
	});
	pick.onDidAccept(() => {
		const chosen = pick.selectedItems[0];
		pick.hide();
		if (chosen?.command) {
			void vscode.commands.executeCommand(chosen.command, ...(chosen.args ?? []));
		}
	});
	pick.onDidHide(() => pick.dispose());
	pick.show();
}
