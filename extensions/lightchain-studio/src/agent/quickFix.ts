import * as vscode from 'vscode';

/**
 * Lightbulb actions that hand code to Lightchain AI: "Fix with Lightchain AI" on
 * errors/warnings, and "Ask Lightchain AI about this" on a selection.
 */
export class LightchainCodeActions implements vscode.CodeActionProvider {
	static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty];

	provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];
		const problems = ctx.diagnostics.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
		if (problems.length) {
			const fix = new vscode.CodeAction('Fix with Lightchain AI', vscode.CodeActionKind.QuickFix);
			fix.diagnostics = problems;
			fix.isPreferred = false;
			fix.command = { command: 'lightchain.ai.fix', title: 'Fix with Lightchain AI', arguments: [doc.uri, problems.map(d => ({ line: d.range.start.line + 1, endLine: d.range.end.line + 1, message: d.message.split('\n')[0] }))] };
			actions.push(fix);
		}
		if (!range.isEmpty) {
			const ask = new vscode.CodeAction('Ask Lightchain AI about this', vscode.CodeActionKind.Empty);
			ask.command = { command: 'lightchain.ai.askSelection', title: 'Ask Lightchain AI about this' };
			actions.push(ask);
		}
		return actions;
	}
}
