import * as vscode from 'vscode';
import { Finding, scanSolidity } from './security';

const SKIP = /(^|\/)(lib|node_modules|out|cache|broadcast)\//;

/**
 * Shows the security check's findings as problems in Solidity files while you
 * type. "Fix with Lightchain AI" (the lightbulb) works on them like on any
 * other problem. Serious findings are red, the rest yellow.
 */
export class SecurityWatch implements vscode.Disposable {
	private readonly problems = vscode.languages.createDiagnosticCollection('lightchain-security');
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly disposables: vscode.Disposable[] = [this.problems];

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument(d => this.check(d)),
			vscode.workspace.onDidSaveTextDocument(d => this.check(d)),
			vscode.workspace.onDidCloseTextDocument(d => this.problems.delete(d.uri)),
			vscode.workspace.onDidChangeTextDocument(e => {
				const key = e.document.uri.toString();
				clearTimeout(this.timers.get(key));
				this.timers.set(key, setTimeout(() => this.check(e.document), 500));
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('lightchain.security')) {
					this.problems.clear();
					vscode.workspace.textDocuments.forEach(d => this.check(d));
				}
			}),
		);
		vscode.workspace.textDocuments.forEach(d => this.check(d));
	}

	private get enabled(): boolean {
		return vscode.workspace.getConfiguration('lightchain.security').get<boolean>('check', true);
	}

	private applies(doc: vscode.TextDocument): boolean {
		return doc.uri.scheme === 'file' && doc.fileName.endsWith('.sol') && !SKIP.test(vscode.workspace.asRelativePath(doc.uri, false));
	}

	private check(doc: vscode.TextDocument): void {
		if (!this.applies(doc)) {
			return;
		}
		if (!this.enabled) {
			this.problems.delete(doc.uri);
			return;
		}
		this.problems.set(doc.uri, scanSolidity(doc.getText()).map(f => {
			const d = new vscode.Diagnostic(new vscode.Range(f.line, f.col, f.endLine, f.endCol), `${f.message}\n${f.fix}`, f.severity === 'high' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
			d.source = 'Lightchain security';
			d.code = f.rule;
			return d;
		}));
	}

	/** Findings in a project file right now (open buffer or disk). */
	async findings(relative: string): Promise<Finding[]> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root || !this.enabled) {
			return [];
		}
		const uri = vscode.Uri.joinPath(root, relative);
		try {
			const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
			return scanSolidity(open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
		} catch {
			return [];
		}
	}

	dispose(): void {
		this.timers.forEach(t => clearTimeout(t));
		this.disposables.forEach(d => d.dispose());
	}
}
