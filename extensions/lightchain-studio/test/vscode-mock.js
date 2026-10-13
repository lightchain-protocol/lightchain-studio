// Minimal stand-in for the `vscode` module so extension code can run under node:test.
class EventEmitter { constructor() { this.l = []; this.event = fn => { this.l.push(fn); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} }
const uri = fsPath => ({ fsPath, path: fsPath, scheme: 'file', toString: () => 'file://' + fsPath });
module.exports = {
	EventEmitter,
	Uri: { parse: s => ({ toString: () => s, fsPath: s }), joinPath: (b, ...p) => uri([b.fsPath, ...p].join('/')), file: uri },
	RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	ProgressLocation: { Notification: 15, Window: 10 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	ThemeColor: class { constructor(id) { this.id = id; } },
	TreeItem: class { constructor(label) { this.label = label; } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
	languages: { getDiagnostics: () => [] },
	commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
	window: {
		createOutputChannel: () => ({ appendLine() {}, warn() {}, info() {}, dispose() {} }),
		showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showErrorMessage: async () => undefined,
		onDidChangeActiveTextEditor: () => ({ dispose() {} }), onDidChangeTextEditorSelection: () => ({ dispose() {} }),
		activeTextEditor: undefined,
	},
	workspace: {
		name: 'test-project', workspaceFolders: undefined, textDocuments: [], isTrusted: true,
		fs: {}, findFiles: async () => [], asRelativePath: p => String(p.fsPath ?? p),
		getConfiguration: () => ({ get: (_k, d) => d }), getWorkspaceFolder: () => undefined,
	},
};
