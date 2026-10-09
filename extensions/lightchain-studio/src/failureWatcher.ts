import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { findForge } from './foundry';

/**
 * When `forge build` / `forge test` fails — typed in the terminal or run from the
 * Build / Test buttons — offer "Fix with Lightchain AI" and hand the output to the chat.
 */
const FORGE = /^\s*(?:\S*\/)?forge\s+(build|test)\b/;
const MAX_KEEP = 200_000;

export function watchFailures(onFix: (command: string, output: string) => void): vscode.Disposable {
	const outputs = new Map<vscode.TerminalShellExecution, string>();
	const offer = async (command: string, output: () => Thenable<string>) => {
		const pick = await vscode.window.showWarningMessage(`${command} failed.`, 'Fix with Lightchain AI');
		if (pick) {
			onFix(command, await output());
		}
	};
	return vscode.Disposable.from(
		// terminal: read the output while the command runs (needs shell integration)
		vscode.window.onDidStartTerminalShellExecution(async e => {
			if (!FORGE.test(e.execution.commandLine.value)) {
				return;
			}
			outputs.set(e.execution, '');
			try {
				for await (const chunk of e.execution.read()) {
					const so = (outputs.get(e.execution) ?? '') + chunk;
					outputs.set(e.execution, so.length > MAX_KEEP ? so.slice(-MAX_KEEP) : so);
				}
			} catch { /* terminal closed */ }
		}),
		vscode.window.onDidEndTerminalShellExecution(e => {
			const output = outputs.get(e.execution);
			outputs.delete(e.execution);
			if (output === undefined || !e.exitCode) {
				return;
			}
			void offer(e.execution.commandLine.value.trim(), async () => stripAnsi(output));
		}),
		// Build / Test tasks: the output stays in the task terminal, so run it again to capture it
		vscode.tasks.onDidEndTaskProcess(e => {
			const def = e.execution.task.definition;
			if (def.type !== 'lightchain' || !e.exitCode || (def.task !== 'Build' && def.task !== 'Test')) {
				return;
			}
			const args = def.task === 'Build' ? ['build'] : ['test', '-vv'];
			void offer(`forge ${args.join(' ')}`, () => rerun(args));
		}),
	);
}

function rerun(args: string[]): Thenable<string> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const forge = findForge();
	if (!root || !forge) {
		return Promise.resolve('(could not run forge again to capture the output)');
	}
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Collecting the output of forge ${args[0]}…` }, () => new Promise(resolve => {
		const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin${path.delimiter}${process.env.PATH ?? ''}` };
		execFile(forge, args, { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env }, (_err, stdout, stderr) => resolve(stripAnsi(`${stdout}\n${stderr}`.trim())));
	}));
}

function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

/** The chat instruction for a failed command (keeps the end of long output, where failures are summarised). */
export function fixPrompt(command: string, output: string): string {
	const tail = output.length > 5_000 ? `… (earlier output omitted)\n${output.slice(-5_000)}` : output;
	return `\`${command}\` failed with this output:\n\n\`\`\`\n${tail}\n\`\`\`\n\nFind the cause and fix it. Decide whether the code or the test is wrong and say which; read_file before changing a file, then write_file its complete corrected content.`;
}
