import * as vscode from 'vscode';
import { InferenceProvider } from './agent/agent';

/**
 * "Commit with Lightchain AI": writes a commit message for the project's changes
 * into the Source Control box. The user reviews it and commits (nothing is committed here).
 */
interface GitRepo { rootUri: vscode.Uri; inputBox: { value: string }; diff(cached?: boolean): Promise<string>; state: { workingTreeChanges: unknown[]; indexChanges: unknown[]; untrackedChanges?: { uri: vscode.Uri }[] } }

const MAX_DIFF = 12_000;

export function commitPrompt(diff: string, untracked: string[]): string {
	const body = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n… (diff truncated)' : diff;
	return [
		'Write a git commit message for these changes.',
		'Format: a summary line of at most 72 characters in the imperative mood (e.g. "Add ticket refunds to Raffle"), then a blank line, then 1–5 short bullet points on what changed and why. No code fences, no quotes, nothing else.',
		'',
		...(untracked.length ? [`New files: ${untracked.join(', ')}`, ''] : []),
		'```diff',
		body,
		'```',
	].join('\n');
}

/** The message from the model's reply (drops fences, quotes and preambles). */
export function cleanMessage(reply: string): string {
	let text = reply.replace(/```[\w-]*\n?/g, '').trim();
	text = text.replace(/^(here(?:'s| is) (?:a |the )?(?:suggested )?commit message:?|commit message:)\s*/i, '');
	return text.replace(/^["'`]+|["'`]+$/g, '').trim();
}

export async function commitWithAi(provider: () => InferenceProvider | undefined): Promise<void> {
	const git = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: GitRepo[] } }>('vscode.git');
	const api = git ? (git.isActive ? git.exports : await git.activate()).getAPI(1) : undefined;
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const repo = api?.repositories.find(r => folder?.startsWith(r.rootUri.fsPath)) ?? api?.repositories[0];
	if (!repo) {
		const pick = await vscode.window.showInformationMessage('This project is not a git repository yet.', 'Initialize Repository');
		if (pick) {
			await vscode.commands.executeCommand('git.init');
		}
		return;
	}
	const staged = await repo.diff(true);
	const diff = staged.trim() ? staged : await repo.diff(false);
	const untracked = (repo.state.untrackedChanges ?? []).map(c => vscode.workspace.asRelativePath(c.uri, false)).slice(0, 30);
	if (!diff.trim() && !untracked.length) {
		vscode.window.showInformationMessage('There are no changes to commit.');
		return;
	}
	const p = provider();
	if (!p) {
		vscode.window.showWarningMessage('Connect a wallet and pick a model to use Lightchain AI.');
		return;
	}
	const message = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Lightchain AI is writing the commit message…', cancellable: true }, async (progress, token) => {
		const ac = new AbortController();
		token.onCancellationRequested(() => ac.abort());
		let reply = '';
		for await (const d of p.chat([{ role: 'user', content: commitPrompt(diff, untracked) }], ac.signal, s => progress.report({ message: s }))) {
			reply += d;
		}
		return cleanMessage(reply);
	}).then(m => m, err => {
		vscode.window.showErrorMessage(`Lightchain AI could not write the message: ${(err as Error).message}`);
		return undefined;
	});
	if (message) {
		repo.inputBox.value = message;
		await vscode.commands.executeCommand('workbench.view.scm');
		vscode.window.showInformationMessage(`Commit message ready in Source Control${staged.trim() ? '' : ' (stage the files you want, then commit)'}.`);
	}
}
