import * as vscode from 'vscode';
import { NETWORKS } from './networks';
import { TEMPLATES } from './templates';
import { findForge } from './foundry';
import { execFile } from 'node:child_process';

/** A project created from a description: Lightchain AI shapes it once the window has opened it. */
export interface PendingBuild { path: string; description: string; template: string }
export const PENDING_BUILD = 'lightchain.pendingBuild';

let state: vscode.Memento | undefined;
/** Where "Describe your app" leaves its request for the window that opens the new project. */
export function setPendingStore(memento: vscode.Memento): void {
	state = memento;
}

/** The starter closest to a description (the AI adapts it afterwards). */
export function templateFor(description: string): string {
	const d = description.toLowerCase();
	const score: [string, RegExp][] = [
		['nft', /\b(nft|erc-?721|collection|collectible|art|mint(ing)?|pfp|badge|ticket nft)\w*/g],
		['token', /\b(token|erc-?20|coin|currency|points|reward|stak(e|ing)|airdrop|vesting)\w*/g],
		['coinflip', /\b(game|flip|bet|wager|lottery|raffle|dice|casino|guess|play)\w*/g],
		['escrow', /\b(escrow|payment|pay|marketplace|sell|buy|freelanc|invoice|deposit|refund|arbiter)\w*/g],
	];
	let best = 'counter', top = 0;
	for (const [id, re] of score) {
		const n = d.match(re)?.length ?? 0;
		if (n > top) {
			best = id;
			top = n;
		}
	}
	return best;
}

/** Opens the New Project window (a Lightchain modal, not the command palette). */
export async function newProject(): Promise<void> {
	await vscode.commands.executeCommand('lightchain.project.newPanel');
}

/** A project name from a description, for pre-filling the name field. */
export function suggestName(description: string): string {
	return slug(description);
}

/** Writes a Foundry project for Lightchain from a template; reports 'files' then 'library'. */
export async function createProject(opts: { template: typeof TEMPLATES[number]; name: string; parent: vscode.Uri; description?: string }, report: (step: 'files' | 'library') => void): Promise<vscode.Uri> {
	const { template, name, parent, description } = opts;
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name.trim())) {
		throw new Error('Use letters, numbers, dots, dashes and underscores in the name.');
	}
	const root = vscode.Uri.joinPath(parent, name.trim());
	if (await vscode.workspace.fs.stat(root).then(() => true, () => false)) {
		throw new Error(`A folder named ${name.trim()} already exists there. Pick another name.`);
	}
	report('files');

	const t = NETWORKS.testnet, m = NETWORKS.mainnet;
	const files: Record<string, string> = {
		'foundry.toml': `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"

[rpc_endpoints]
lightchain_testnet = "${t.rpcUrl}"
lightchain_mainnet = "${m.rpcUrl}"

# Contract verification on Lightscan (Blockscout)
[etherscan]
lightchain_testnet = { key = "lightscan", url = "${t.explorerUrl}/api", chain = ${t.chainId} }
lightchain_mainnet = { key = "lightscan", url = "${m.explorerUrl}/api", chain = ${m.chainId} }
`,
		'.gitignore': `out/
cache/
broadcast/*/31337/
.env
`,
		'README.md': `# ${name.trim()}

A Foundry project for Lightchain, created with Lightchain Studio.

## Setup

\`\`\`bash
forge install foundry-rs/forge-std
forge build
forge test
\`\`\`

## Deploy to Lightchain testnet (chain ${t.chainId})

\`\`\`bash
forge script script/Deploy.s.sol --rpc-url lightchain_testnet --broadcast --verify
\`\`\`

Deployments appear in Lightchain Studio's **Deployed Programs** panel (read from \`broadcast/\`).
Test LCAI: https://lightfaucet.ai · Explorer: ${t.explorerUrl}
`,
	};

	Object.assign(files, template.files);
	const encoder = new TextEncoder();
	for (const [path, content] of Object.entries(files)) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, path), encoder.encode(content));
	}
	// Install forge-std so the project builds and tests right away.
	const forge = findForge();
	if (forge) {
		report('library');
		{
			const run = (cmd: string, args: string[]) => new Promise<boolean>(resolve =>
				execFile(cmd, args, { cwd: root.fsPath, timeout: 180_000, env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` } }, err => resolve(!err)));
			const ok = await run('git', ['init', '-q']) && await run(forge, ['install', 'foundry-rs/forge-std']);
			if (!ok) {
				vscode.window.showWarningMessage('Could not install forge-std automatically (git and internet access are needed). Run "forge install foundry-rs/forge-std" in the project.');
			}
		}
	}
	if (description && state) {
		await state.update(PENDING_BUILD, { path: root.fsPath, description, template: template.label } satisfies PendingBuild);
	}
	return root;
}

function slug(text: string): string {
	const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'where', 'people', 'app'].includes(w));
	return (words.slice(0, 3).join('-') || 'my-lightchain-app').slice(0, 40);
}
