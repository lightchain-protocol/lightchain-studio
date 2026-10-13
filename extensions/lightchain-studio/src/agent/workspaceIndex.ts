import * as vscode from 'vscode';
import { Hit, IndexFile, LocalIndex } from './localIndex';

const INCLUDE = '**/*.{sol,ts,tsx,js,jsx,mjs,md,toml,yaml,yml,json}';
const EXCLUDE = '{**/node_modules/**,**/lib/**,**/out/**,**/cache/**,**/broadcast/**,**/artifacts/**,**/dist/**,**/build/**,**/coverage/**,**/.git/**,**/.lightchain/**,**/*.min.js,**/package-lock.json,**/*.lock}';
const MAX_FILES = 400;
const MAX_FILE_BYTES = 120_000;

/**
 * The local index of the open project: reads the project's source files from
 * disk (open editors win, so unsaved work counts) and keeps the index current.
 * Files are re-read only when their modification time changes.
 */
export class WorkspaceIndex {
	readonly index = new LocalIndex();
	private cache = new Map<string, { mtime: number; text: string }>();
	private refreshing?: Promise<void>;
	private refreshedAt = 0;

	get enabled(): boolean {
		return vscode.workspace.getConfiguration('lightchain.ai').get<boolean>('localContext', true);
	}

	/** Brings the index up to date (at most once every couple of seconds). */
	refresh(force = false): Promise<void> {
		if (!force && Date.now() - this.refreshedAt < 2_000) {
			return this.refreshing ?? Promise.resolve();
		}
		return this.refreshing ??= this.read().finally(() => {
			this.refreshing = undefined;
			this.refreshedAt = Date.now();
		});
	}

	private async read(): Promise<void> {
		const uris = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, MAX_FILES);
		const next = new Map<string, { mtime: number; text: string }>();
		const files: IndexFile[] = [];
		await Promise.all(uris.map(async uri => {
			const path = vscode.workspace.asRelativePath(uri, false);
			try {
				const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
				if (open) {
					files.push({ path, text: open.getText() });
					return;
				}
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.size > MAX_FILE_BYTES) {
					return;
				}
				const had = this.cache.get(path);
				const entry = had && had.mtime === stat.mtime ? had : { mtime: stat.mtime, text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
				next.set(path, entry);
				files.push({ path, text: entry.text });
			} catch { /* deleted while reading */ }
		}));
		this.cache = next;
		this.index.update(files.sort((a, b) => a.path.localeCompare(b.path)));
	}

	/** Code related to `query`, leaving out files the prompt already carries in full. */
	async search(query: string, exclude: Iterable<string> = [], opts: { maxChunks?: number; maxChars?: number } = {}): Promise<Hit[]> {
		await this.refresh();
		return this.index.search(query, { exclude: new Set(exclude), ...opts });
	}
}
