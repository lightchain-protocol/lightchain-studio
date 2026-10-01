import * as vscode from 'vscode';

/** Read-only virtual documents holding proposed file contents, for the diff editor. */
export const PROPOSAL_SCHEME = 'lightchain-proposed';

export class ProposalStore implements vscode.TextDocumentContentProvider {
	private readonly docs = new Map<string, string>();
	private seq = 0;

	add(relPath: string, content: string): vscode.Uri {
		const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${++this.seq}/${relPath}` });
		this.docs.set(uri.toString(), content);
		return uri;
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.docs.get(uri.toString()) ?? '';
	}

	/** Open VS Code's diff editor: current file (or empty) ↔ proposed content. */
	async showDiff(root: string, relPath: string, before: string, after: string): Promise<void> {
		const right = this.add(relPath, after);
		const left = before ? vscode.Uri.joinPath(vscode.Uri.file(root), relPath) : this.add(`(new) ${relPath}`, '');
		await vscode.commands.executeCommand('vscode.diff', left, right, `${relPath} ↔ Lightchain AI proposal`, { preview: true });
	}
}
