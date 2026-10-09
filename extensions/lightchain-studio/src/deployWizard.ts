import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { AbiParameter, encodeDeployData, formatEther, parseEther, type Abi, type Hex } from 'viem';
import { Wallet } from './wallet';
import { NetworkState } from './networkState';
import { addressUrl } from './networks';
import { DeployedProgramsProvider } from './deployedPrograms';
import { findForge } from './foundry';
import { parseArg } from './interact';

/**
 * Deploy a contract without writing a Foundry script: build, pick a contract,
 * fill constructor arguments, sign with the Lightchain wallet. The result is added
 * to Deployed Programs.
 */
interface Artifact { name: string; source: string; abi: Abi; bytecode: Hex }

async function build(root: string): Promise<string | undefined> {
	const forge = findForge();
	if (!forge) {
		return 'Foundry (forge) is not installed.';
	}
	return new Promise(resolve => execFile(forge, ['build'], { cwd: root, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin${path.delimiter}${process.env.PATH ?? ''}` } },
		(err, stdout, stderr) => resolve(err ? (stderr || stdout || err.message).trim().split('\n').slice(-12).join('\n') : undefined)));
}

/** Deployable contracts compiled from the project's src/ (not tests, scripts or libraries). */
async function artifacts(root: vscode.Uri): Promise<Artifact[]> {
	const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'out/**/*.json'), '**/build-info/**', 2000);
	const result: Artifact[] = [];
	for (const f of files) {
		try {
			const a = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(f)));
			const target = a?.metadata?.settings?.compilationTarget;
			const source: string = a?.ast?.absolutePath ?? (target ? Object.keys(target)[0] : '');
			const bytecode: string = a?.bytecode?.object ?? '';
			if (!source.startsWith('src/') || bytecode.length <= 2 || !Array.isArray(a.abi)) {
				continue; // tests, scripts, libraries, interfaces and abstract contracts
			}
			result.push({ name: path.basename(f.path, '.json'), source, abi: a.abi, bytecode: (bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`) as Hex });
		} catch { /* not an artifact */ }
	}
	return result.sort((x, y) => x.name.localeCompare(y.name));
}

export async function deployWizard(wallet: Wallet, network: NetworkState, programs: DeployedProgramsProvider, contractName?: string): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Open a Foundry project to deploy a contract.');
		return;
	}
	const account = wallet.active;
	if (!account) {
		const pick = await vscode.window.showWarningMessage('Connect a wallet to deploy.', 'Connect Wallet');
		if (pick) {
			await vscode.commands.executeCommand('lightchain.wallet.menu');
		}
		return;
	}
	const net = network.current;
	const failure = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Building contracts…' }, () => build(folder.uri.fsPath));
	if (failure) {
		const fix = await vscode.window.showErrorMessage(`The build failed, so nothing can be deployed.\n${failure}`, 'Fix with Lightchain AI');
		if (fix) {
			await vscode.commands.executeCommand('lightchain.ai.focus');
		}
		return;
	}
	const all = await artifacts(folder.uri);
	if (!all.length) {
		vscode.window.showWarningMessage('No deployable contract found in src/.');
		return;
	}
	let chosen = contractName ? all.find(a => a.name === contractName) : undefined;
	if (!chosen) {
		const pick = await vscode.window.showQuickPick(all.map(a => ({ label: a.name, description: a.source, a })), { title: `Deploy to Lightchain ${net.label} — choose a contract` });
		if (!pick) {
			return;
		}
		chosen = pick.a;
	}
	const ctor = chosen.abi.find(x => x.type === 'constructor') as { inputs: readonly AbiParameter[]; stateMutability?: string } | undefined;
	const args: unknown[] = [];
	const shown: string[] = [];
	for (const [i, p] of (ctor?.inputs ?? []).entries()) {
		const raw = await vscode.window.showInputBox({
			title: `Deploy ${chosen.name} — constructor argument ${i + 1} of ${ctor!.inputs.length}`,
			prompt: `${p.name || `arg${i}`} (${p.type})${p.type.endsWith(']') || p.type === 'tuple' ? ' — JSON, e.g. [1, 2]' : ''}`,
			ignoreFocusOut: true,
			validateInput: v => { try { parseArg(p, v); return undefined; } catch (err) { return (err as Error).message; } },
		});
		if (raw === undefined) {
			return;
		}
		args.push(parseArg(p, raw));
		shown.push(`${p.name || `arg${i}`} = ${raw.trim()}`);
	}
	let value: bigint | undefined;
	if (ctor?.stateMutability === 'payable') {
		const raw = await vscode.window.showInputBox({ title: `Deploy ${chosen.name}`, prompt: 'LCAI to send with the deployment (optional)', value: '0', ignoreFocusOut: true, validateInput: v => { try { parseEther(v.trim() || '0'); return undefined; } catch { return 'Enter an amount, e.g. 0.5'; } } });
		if (raw === undefined) {
			return;
		}
		value = parseEther(raw.trim() || '0') || undefined;
	}
	// offer a Lightchain AI security review first (on mainnet before the real-money confirmation)
	const audit = 'Audit with Lightchain AI First';
	if (net.id !== 'mainnet') {
		const ok = await vscode.window.showInformationMessage(`Deploy ${chosen.name} to Lightchain ${net.label}?`, {
			modal: true,
			detail: [`From ${account.name} (${account.address})`, ...shown, ...(value ? [`Value: ${formatEther(value)} LCAI`] : [])].join('\n'),
		}, 'Deploy', audit);
		if (ok === audit) {
			await vscode.commands.executeCommand('lightchain.ai.audit', chosen.source);
			return;
		}
		if (ok !== 'Deploy') {
			return;
		}
	} else {
		const ok = await vscode.window.showWarningMessage(`Review ${chosen.name} before deploying to mainnet?`, {
			modal: true,
			detail: 'Mainnet contracts hold real LCAI and usually cannot be changed after deployment. Lightchain AI can do a security review of the source first.',
		}, audit, 'Deploy Without Review');
		if (ok === audit) {
			await vscode.commands.executeCommand('lightchain.ai.audit', chosen.source);
			return;
		}
		if (ok !== 'Deploy Without Review') {
			return;
		}
	}
	const data = encodeDeployData({ abi: chosen.abi, bytecode: chosen.bytecode, args });
	try {
		const address = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${chosen.name}…${account.kind === 'browser' ? ' Approve in your browser wallet.' : ''}` }, async () => {
			const hash = await wallet.sendRawFromTx(account, net, { data, value }, `Deploy ${chosen!.name}${shown.length ? ` (${shown.join(', ')})` : ''}`);
			const receipt = await wallet.publicClient(net).waitForTransactionReceipt({ hash, timeout: 180_000 });
			if (receipt.status !== 'success' || !receipt.contractAddress) {
				throw new Error(`The deployment transaction reverted (${hash}).`);
			}
			return receipt.contractAddress;
		});
		await programs.addManual(address, chosen.name);
		const next = await vscode.window.showInformationMessage(`${chosen.name} deployed to ${address} on ${net.label}.`, 'Interact', 'Open on Lightscan');
		if (next === 'Open on Lightscan') {
			await vscode.env.openExternal(vscode.Uri.parse(addressUrl(net, address)));
		} else if (next === 'Interact') {
			await vscode.commands.executeCommand('lightchain.programs.interactAddress', address, chosen.name);
		}
	} catch (err) {
		const e = err as { shortMessage?: string; message?: string };
		vscode.window.showErrorMessage(`Deploy failed: ${(e.shortMessage ?? e.message ?? String(err)).split('\n')[0]}`);
	}
}

/** "Deploy" above each deployable contract in a Solidity file. */
export class DeployCodeLens implements vscode.CodeLensProvider {
	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		if (!/(^|\/)src\//.test(vscode.workspace.asRelativePath(doc.uri, false))) {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		const re = /^\s*contract\s+([A-Za-z_]\w*)/gm;
		for (let m; (m = re.exec(doc.getText()));) {
			const pos = doc.positionAt(m.index + m[0].indexOf('contract'));
			lenses.push(new vscode.CodeLens(new vscode.Range(pos, pos), { title: '$(rocket) Deploy', command: 'lightchain.deployContract', arguments: [m[1]] }));
		}
		return lenses;
	}
}
