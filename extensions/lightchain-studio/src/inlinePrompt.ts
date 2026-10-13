import * as vscode from 'vscode';

/**
 * The ⌘I prompt, shown in the editor right at the selection (a comment-thread
 * widget used as an inline input box), with progress shown in the same place.
 */
export interface InlineSession {
	instruction: string;
	/** Shows progress or an error under the instruction. */
	status(text: string): void;
	/** Lets the user edit the instruction and send again (after an error). */
	retry(): Promise<string | undefined>;
	close(): void;
}

const AI = { name: 'Lightchain AI' };
const YOU = { name: 'You' };

export class InlinePrompt implements vscode.Disposable {
	private readonly controller = vscode.comments.createCommentController('lightchain.inline', 'Lightchain AI');
	private readonly waiting = new Map<vscode.CommentThread, (text: string | undefined) => void>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.controller.options = { prompt: 'Describe the change…', placeHolder: 'e.g. add a require that msg.value > 0 — Enter for a new line, ⌘⏎ to send' };
		this.disposables.push(
			this.controller,
			vscode.commands.registerCommand('lightchain.inline.submit', (reply: vscode.CommentReply) => this.answer(reply.thread, reply.text.trim() || undefined)),
			vscode.commands.registerCommand('lightchain.inline.cancel', (thread: vscode.CommentThread) => this.answer(thread, undefined)),
		);
	}

	/** Opens the prompt above `range`; undefined when the user cancels. */
	async ask(doc: vscode.TextDocument, range: vscode.Range, title: string): Promise<InlineSession | undefined> {
		const thread = this.controller.createCommentThread(doc.uri, range, []);
		thread.label = title;
		thread.canReply = true;
		thread.contextValue = 'lightchain.inline';
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		const first = await this.wait(thread);
		if (!first) {
			thread.dispose();
			return undefined;
		}
		let instruction = first;
		const show = (status?: string) => {
			thread.comments = [
				comment(YOU, instruction),
				...(status ? [comment(AI, status)] : []),
			];
		};
		show('Starting…');
		thread.canReply = false;
		return {
			get instruction() { return instruction; },
			status: text => show(text),
			retry: async () => {
				thread.canReply = true;
				const next = await this.wait(thread);
				if (!next) {
					thread.dispose();
					return undefined;
				}
				instruction = next;
				thread.canReply = false;
				show('Starting…');
				return next;
			},
			close: () => thread.dispose(),
		};
	}

	private wait(thread: vscode.CommentThread): Promise<string | undefined> {
		return new Promise(resolve => this.waiting.set(thread, resolve));
	}

	private answer(thread: vscode.CommentThread, text: string | undefined): void {
		const resolve = this.waiting.get(thread);
		this.waiting.delete(thread);
		if (resolve) {
			resolve(text);
		} else if (!text) {
			thread.dispose();
		}
	}

	dispose(): void {
		this.waiting.forEach(resolve => resolve(undefined));
		this.disposables.forEach(d => d.dispose());
	}
}

function comment(author: vscode.CommentAuthorInformation, text: string): vscode.Comment {
	return { author, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview };
}
