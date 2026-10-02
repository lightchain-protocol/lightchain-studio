import * as vscode from 'vscode';

/**
 * Project context attached to a prompt (Cursor-style): the file the user is
 * looking at, their selection, files they @-mentioned, and the compiler problems
 * in those files. Sent inside the prompt so the model edits real code.
 */
export interface PromptContext {
	file?: string;                                  // workspace-relative path of the active editor
	selection?: { start: number; end: number };     // 1-based line range of a non-empty selection
	mentions: string[];                             // workspace-relative paths from @-mentions
}

const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 30_000;
const MAX_PROBLEMS = 20;

/** Files offered in the @-mention picker. */
export async function mentionableFiles(): Promise<string[]> {
	const uris = await vscode.workspace.findFiles(
		'**/*.{sol,toml,md,json,ts,js,mjs,yaml,yml,txt}',
		'{**/node_modules/**,**/lib/**,**/out/**,**/cache/**,**/broadcast/**,**/.git/**}',
		500,
	);
	return uris.map(u => vscode.workspace.asRelativePath(u, false)).sort();
}

/** What the composer should show as chips for the current editor state. */
export function editorContext(): { file?: string; selection?: { start: number; end: number } } {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
		return {};
	}
	const file = vscode.workspace.asRelativePath(editor.document.uri, false);
	const sel = editor.selection;
	return {
		file,
		selection: sel.isEmpty ? undefined : { start: sel.start.line + 1, end: sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1) },
	};
}

/** The context block placed before the user's request. Empty when nothing is attached. */
export async function buildContext(ctx: PromptContext): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		return '';
	}
	const files = [...new Set([...(ctx.file ? [ctx.file] : []), ...ctx.mentions])];
	const parts: string[] = [];
	let total = 0;
	for (const rel of files) {
		const uri = vscode.Uri.joinPath(root, rel);
		let text: string;
		try {
			// prefer the editor's buffer: it may hold unsaved changes
			const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
			text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			continue;
		}
		if (total >= MAX_TOTAL_CHARS) {
			parts.push(`File ${rel}: (not included — context limit reached; read_file it if needed)`);
			continue;
		}
		const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total);
		const body = text.length > room ? text.slice(0, room) + '\n… (truncated — read_file for the rest)' : text;
		total += body.length;
		parts.push(`File ${rel}:\n\`\`\`\n${numbered(body)}\n\`\`\``);
	}
	if (ctx.file && ctx.selection) {
		parts.push(`The user selected lines ${ctx.selection.start}–${ctx.selection.end} of ${ctx.file}; the request is about that part.`);
	}
	const problems = files.flatMap(rel => {
		const uri = vscode.Uri.joinPath(root, rel);
		return vscode.languages.getDiagnostics(uri)
			.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
			.map(d => `${rel}:${d.range.start.line + 1}: ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${d.message.split('\n')[0]}`);
	}).slice(0, MAX_PROBLEMS);
	if (problems.length) {
		parts.push(`Current problems:\n${problems.join('\n')}`);
	}
	return parts.length ? `Project context (current file contents, line-numbered — line numbers are not part of the file):\n\n${parts.join('\n\n')}\n\n---\n\n` : '';
}

function numbered(text: string): string {
	return text.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
}
