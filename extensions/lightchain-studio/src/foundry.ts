import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { NetworkState } from './networkState';
import { Wallet } from './wallet';
import { SigningProxy } from './signingProxy';
import { shortAddress } from './deployedPrograms';

/**
 * Foundry inside Lightchain Studio: Build, Test, Deploy (forge script) and
 * contract verification on Lightscan. Deploys sign through SigningProxy, so
 * the active Lightchain wallet (local key or browser wallet) signs and keys
 * never reach forge. Deployments land in broadcast/, which Deployed Programs
 * watches.
 */
export function findForge(): string | undefined {
	const configured = vscode.workspace.getConfiguration('lightchain.foundry').get<string>('path')?.trim();
	const candidates = [
		configured,
		path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge'),
		...(process.env.PATH ?? '').split(path.delimiter).map(d => path.join(d, process.platform === 'win32' ? 'forge.exe' : 'forge')),
	].filter((p): p is string => !!p);
	return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}

function projectRoot(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.find(f => fs.existsSync(path.join(f.uri.fsPath, 'foundry.toml')));
}

async function requireForge(): Promise<string | undefined> {
	const forge = findForge();
	if (forge) {
		return forge;
	}
	const choice = await vscode.window.showWarningMessage('Foundry is not installed. Lightchain Studio uses Foundry (forge) to build, test and deploy contracts.', 'Install Foundry', 'Set Path…');
	if (choice === 'Install Foundry') {
		const term = vscode.window.createTerminal({ name: 'Install Foundry' });
		term.show();
		term.sendText('curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup');
	} else if (choice === 'Set Path…') {
		vscode.commands.executeCommand('workbench.action.openSettings', 'lightchain.foundry.path');
	}
	return undefined;
}

function forgeTask(name: string, forge: string, args: string[], root: vscode.WorkspaceFolder, env?: Record<string, string>): vscode.Task {
	const task = new vscode.Task(
		{ type: 'lightchain', task: name },
		root,
		name,
		'Lightchain',
		new vscode.ProcessExecution(forge, args, { cwd: root.uri.fsPath, env }),
		'$lightchain-forge',
	);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
	return task;
}

export function registerFoundry(context: vscode.ExtensionContext, wallet: Wallet, network: NetworkState): void {
	const run = async (name: string, args: (root: vscode.WorkspaceFolder) => string[]) => {
		const root = projectRoot();
		if (!root) {
			vscode.window.showWarningMessage('Open a Foundry project (a folder with foundry.toml) to use Lightchain build tools.', 'New Lightchain Project').then(c => c && vscode.commands.executeCommand('lightchain.project.new'));
			return;
		}
		const forge = await requireForge();
		if (forge) {
			await vscode.tasks.executeTask(forgeTask(name, forge, args(root), root));
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('lightchain.foundry.build', () => run('Build', () => ['build'])),
		vscode.commands.registerCommand('lightchain.foundry.test', () => run('Test', () => ['test', '-vvv'])),

		vscode.commands.registerCommand('lightchain.foundry.deploy', async (resource?: vscode.Uri) => {
			const root = projectRoot();
			if (!root) {
				vscode.window.showWarningMessage('Open a Foundry project (a folder with foundry.toml) to deploy.');
				return;
			}
			const forge = await requireForge();
			if (!forge) {
				return;
			}
			const account = wallet.active;
			if (!account) {
				vscode.window.showWarningMessage('Connect or create a wallet to deploy.', 'Open Wallet').then(c => c && vscode.commands.executeCommand('lightchain.wallet.menu'));
				return;
			}

			// Which script: the open/clicked *.s.sol, else pick from script/.
			let script = resource?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
			if (!script?.endsWith('.s.sol')) {
				const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'script/**/*.s.sol'), '**/lib/**', 50);
				if (!found.length) {
					vscode.window.showWarningMessage('No deploy scripts found (script/*.s.sol).');
					return;
				}
				const pick = found.length === 1 ? { uri: found[0] } : await vscode.window.showQuickPick(
					found.map(uri => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri })),
					{ title: 'Deploy Script' });
				if (!pick) {
					return;
				}
				script = pick.uri.fsPath;
			}

			const net = network.current;
			const detail = `${path.relative(root.uri.fsPath, script)}\nNetwork: Lightchain ${net.label} (chain ${net.chainId})\nSigner: ${account.name} (${account.address})${account.kind === 'browser' ? '\nYou will approve each transaction in your browser wallet.' : ''}`;
			const go = await vscode.window.showInformationMessage(`Deploy to Lightchain ${net.label}?`, { modal: true, detail }, 'Deploy', 'Deploy & Verify');
			if (!go) {
				return;
			}

			const proxy = new SigningProxy(wallet, account, net);
			const rpc = await proxy.start();
			const args = ['script', path.relative(root.uri.fsPath, script), '--rpc-url', rpc, '--broadcast', '--unlocked', '--sender', account.address, '--slow'];
			if (go === 'Deploy & Verify') {
				args.push('--verify', '--verifier', 'blockscout', '--verifier-url', `${net.explorerUrl}/api/`);
			}
			const task = forgeTask(`Deploy ${path.basename(script)} → ${net.label}`, forge, args, root);
			const exec = await vscode.tasks.executeTask(task);
			const done = vscode.tasks.onDidEndTaskProcess(e => {
				if (e.execution !== exec) {
					return;
				}
				done.dispose();
				proxy.dispose();
				if (e.exitCode === 0) {
					vscode.window.showInformationMessage(`Deployed to Lightchain ${net.label} from ${shortAddress(account.address)} (${proxy.sent} transaction${proxy.sent === 1 ? '' : 's'}).`, 'Show Deployed Programs')
						.then(c => c && vscode.commands.executeCommand('lightchain.deployedPrograms.focus'));
					vscode.commands.executeCommand('lightchain.programs.refresh');
				}
			});
			context.subscriptions.push(done, proxy);
		}),
	);
}
