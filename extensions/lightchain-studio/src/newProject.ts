import * as vscode from 'vscode';
import { NETWORKS } from './networks';
import { TEMPLATES } from './templates';
import { findForge } from './foundry';
import { execFile } from 'node:child_process';

/** Scaffolds a Foundry project preconfigured for Lightchain testnet + mainnet. */
export async function newProject(): Promise<void> {
	const template = await vscode.window.showQuickPick(
		TEMPLATES.map(t => ({ label: t.label, detail: t.detail, template: t })),
		{ title: 'New Lightchain Project — choose a template', matchOnDetail: true });
	if (!template) {
		return;
	}
	const parent = await vscode.window.showOpenDialog({
		title: 'New Lightchain Project — choose a parent folder',
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: 'Create Here',
	});
	if (!parent?.[0]) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: 'New Lightchain Project',
		prompt: 'Project name',
		value: 'my-lightchain-app',
		ignoreFocusOut: true,
		validateInput: v => /^[a-z0-9][a-z0-9._-]*$/i.test(v.trim()) ? undefined : 'Letters, numbers, dot, dash and underscore only',
	});
	if (!name) {
		return;
	}
	const root = vscode.Uri.joinPath(parent[0], name.trim());
	try {
		await vscode.workspace.fs.stat(root);
		vscode.window.showErrorMessage(`${root.fsPath} already exists.`);
		return;
	} catch {
		// does not exist — good
	}

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

	Object.assign(files, template.template.files);
	const encoder = new TextEncoder();
	for (const [path, content] of Object.entries(files)) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, path), encoder.encode(content));
	}
	// Install forge-std so the project builds and tests right away.
	const forge = findForge();
	if (forge) {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${name.trim()}: installing forge-std…` }, async () => {
			const run = (cmd: string, args: string[]) => new Promise<boolean>(resolve =>
				execFile(cmd, args, { cwd: root.fsPath, timeout: 180_000, env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` } }, err => resolve(!err)));
			const ok = await run('git', ['init', '-q']) && await run(forge, ['install', 'foundry-rs/forge-std']);
			if (!ok) {
				vscode.window.showWarningMessage('Could not install forge-std automatically (git and internet access are needed). Run "forge install foundry-rs/forge-std" in the project.');
			}
		});
	}
	await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
}
