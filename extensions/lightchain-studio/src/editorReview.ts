import * as vscode from 'vscode';
import { DiffLine, applyHunks, diffOps } from './agent/lineDiff';

/**
 * Review a proposed change inside the file itself (Cursor-style): removed lines
 * stay in red, added lines appear in green, and each change has Accept / Reject
 * above it. While the review is open the buffer holds both versions; when every
 * change is decided it holds exactly the accepted result and is saved.
 */
export type ReviewOutcome = { declined: number[] } | 'rejected' | 'cancelled';

interface Session {
	doc: vscode.TextDocument;
	before: string;
	after: string;
	ops: DiffLine[];
	hunks: number;
	decisions: Map<number, boolean>;
	starts: Map<number, number>; // hunk → first line in the buffer (undecided hunks)
	done: (outcome: ReviewOutcome) => void;
}

/** Buffer text for a review: undecided changes show both sides, decided ones only the chosen side. */
export function reviewText(ops: DiffLine[], decisions: Map<number, boolean>, trailingNewline: boolean) {
	const lines: string[] = [];
	const plus: number[] = [];
	const minus: number[] = [];
	const starts = new Map<number, number>();
	for (const op of ops) {
		if (op.t === ' ') {
			lines.push(op.s);
			continue;
		}
		const d = op.h === undefined ? undefined : decisions.get(op.h);
		if (d === undefined) {
			if (op.h !== undefined && !starts.has(op.h)) {
				starts.set(op.h, lines.length);
			}
			(op.t === '+' ? plus : minus).push(lines.length);
			lines.push(op.s);
		} else if ((d && op.t === '+') || (!d && op.t === '-')) {
			lines.push(op.s);
		}
	}
	return { text: lines.join('\n') + (lines.length && trailingNewline ? '\n' : ''), plus, minus, starts };
}

export class EditorReview implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly added: vscode.TextEditorDecorationType;
	private readonly removed: vscode.TextEditorDecorationType;

	constructor() {
		this.added = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: 'rgba(62, 183, 94, 0.14)',
			overviewRulerColor: 'rgba(62, 183, 94, 0.8)',
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.removed = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: 'rgba(240, 82, 82, 0.14)',
			textDecoration: 'line-through rgba(240, 82, 82, 0.55)',
			opacity: '0.75',
			overviewRulerColor: 'rgba(240, 82, 82, 0.8)',
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.disposables.push(this.added, this.removed);
		this.disposables.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
			vscode.window.onDidChangeVisibleTextEditors(() => this.sessions.forEach(s => this.decorate(s))),
			vscode.commands.registerCommand('lightchain.review.accept', (uri: string, h: number) => this.decide(uri, h, true)),
			vscode.commands.registerCommand('lightchain.review.reject', (uri: string, h: number) => this.decide(uri, h, false)),
			vscode.commands.registerCommand('lightchain.review.acceptAll', (uri?: string) => this.decideAll(uri, true)),
			vscode.commands.registerCommand('lightchain.review.rejectAll', (uri?: string) => this.decideAll(uri, false)),
			vscode.workspace.onDidCloseTextDocument(doc => {
				const s = this.sessions.get(doc.uri.toString());
				if (s) {
					this.finish(s, 'cancelled', false);
				}
			}),
		);
	}

	/**
	 * Shows the change in the editor. Returns false when it can't (the file has
	 * unsaved edits, or differs from what the change was made against).
	 */
	async start(absPath: string, before: string, after: string, done: (outcome: ReviewOutcome) => void): Promise<boolean> {
		const uri = vscode.Uri.file(absPath);
		const doc = await vscode.workspace.openTextDocument(uri).then(d => d, () => undefined);
		const norm = (t: string) => t.replace(/\r\n/g, '\n');
		if (!doc || doc.isDirty || norm(doc.getText()) !== norm(before) || this.sessions.has(uri.toString())) {
			return false;
		}
		const ops = diffOps(before, after);
		const hunks = ops.reduce((m, o) => Math.max(m, (o.h ?? -1) + 1), 0);
		if (!hunks) {
			return false;
		}
		const s: Session = { doc, before, after, ops, hunks, decisions: new Map(), starts: new Map(), done };
		this.sessions.set(uri.toString(), s);
		await vscode.commands.executeCommand('setContext', 'lightchain.reviewing', true);
		const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		await this.render(s);
		const first = Math.min(...s.starts.values());
		editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		return true;
	}

	/** The panel decided (or the turn ended): put the file back as it was, without reporting. */
	async cancel(absPath: string): Promise<void> {
		const s = this.sessions.get(vscode.Uri.file(absPath).toString());
		if (s) {
			await this.finish(s, 'cancelled', false);
		}
	}

	isReviewing(absPath: string): boolean {
		return this.sessions.has(vscode.Uri.file(absPath).toString());
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const s = this.sessions.get(doc.uri.toString());
		if (!s) {
			return [];
		}
		const uri = doc.uri.toString();
		const open = s.hunks - s.decisions.size;
		const top = new vscode.Range(0, 0, 0, 0);
		const lenses = [
			new vscode.CodeLens(top, { title: `Lightchain AI · ${open} change${open === 1 ? '' : 's'} to review`, command: '' }),
			new vscode.CodeLens(top, { title: 'Accept all ⌘⏎', command: 'lightchain.review.acceptAll', arguments: [uri] }),
			new vscode.CodeLens(top, { title: 'Reject all', command: 'lightchain.review.rejectAll', arguments: [uri] }),
		];
		for (const [h, line] of s.starts) {
			const at = new vscode.Range(line, 0, line, 0);
			lenses.push(
				new vscode.CodeLens(at, { title: '$(check) Accept', command: 'lightchain.review.accept', arguments: [uri, h] }),
				new vscode.CodeLens(at, { title: '$(close) Reject', command: 'lightchain.review.reject', arguments: [uri, h] }),
			);
		}
		return lenses;
	}

	private active(uri?: string): Session | undefined {
		return this.sessions.get(uri ?? vscode.window.activeTextEditor?.document.uri.toString() ?? '') ?? [...this.sessions.values()][0];
	}

	private async decide(uri: string, h: number, accept: boolean): Promise<void> {
		const s = this.sessions.get(uri);
		if (!s || s.decisions.has(h)) {
			return;
		}
		s.decisions.set(h, accept);
		if (s.decisions.size === s.hunks) {
			return this.complete(s);
		}
		await this.render(s);
	}

	private async decideAll(uri: string | undefined, accept: boolean): Promise<void> {
		const s = this.active(uri);
		if (!s) {
			return;
		}
		for (let h = 0; h < s.hunks; h++) {
			if (!s.decisions.has(h)) {
				s.decisions.set(h, accept);
			}
		}
		await this.complete(s);
	}

	private async complete(s: Session): Promise<void> {
		const declined = [...s.decisions].filter(([, ok]) => !ok).map(([h]) => h);
		await this.finish(s, declined.length === s.hunks ? 'rejected' : { declined }, true);
	}

	private async finish(s: Session, outcome: ReviewOutcome, report: boolean): Promise<void> {
		this.sessions.delete(s.doc.uri.toString());
		if (!s.doc.isClosed) {
			const final = outcome === 'rejected' || outcome === 'cancelled' ? s.before : applyHunks(s.before, s.after, outcome.declined);
			await this.replace(s.doc, final);
			await s.doc.save();
			this.clear(s.doc);
		}
		await vscode.commands.executeCommand('setContext', 'lightchain.reviewing', this.sessions.size > 0);
		this.changed.fire();
		if (report) {
			s.done(outcome);
		}
	}

	private async render(s: Session): Promise<void> {
		const r = reviewText(s.ops, s.decisions, s.after.endsWith('\n') || (!s.after && s.before.endsWith('\n')));
		s.starts = r.starts;
		await this.replace(s.doc, r.text);
		this.decorate(s, r.plus, r.minus);
		this.changed.fire();
	}

	private lastLines = new Map<string, { plus: number[]; minus: number[] }>();

	private decorate(s: Session, plus?: number[], minus?: number[]): void {
		const key = s.doc.uri.toString();
		if (plus && minus) {
			this.lastLines.set(key, { plus, minus });
		}
		const lines = this.lastLines.get(key);
		if (!lines) {
			return;
		}
		const ranges = (ls: number[]) => ls.map(l => new vscode.Range(l, 0, l, 0));
		for (const e of vscode.window.visibleTextEditors.filter(e => e.document === s.doc)) {
			e.setDecorations(this.added, ranges(lines.plus));
			e.setDecorations(this.removed, ranges(lines.minus));
		}
	}

	private clear(doc: vscode.TextDocument): void {
		this.lastLines.delete(doc.uri.toString());
		for (const e of vscode.window.visibleTextEditors.filter(e => e.document === doc)) {
			e.setDecorations(this.added, []);
			e.setDecorations(this.removed, []);
		}
	}

	private async replace(doc: vscode.TextDocument, text: string): Promise<void> {
		if (doc.getText() === text) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
		await vscode.workspace.applyEdit(edit);
	}

	dispose(): void {
		for (const s of [...this.sessions.values()]) {
			void this.finish(s, 'cancelled', false);
		}
		this.disposables.forEach(d => d.dispose());
		this.changed.dispose();
	}
}
