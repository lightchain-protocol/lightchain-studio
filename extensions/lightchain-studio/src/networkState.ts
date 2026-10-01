import * as vscode from 'vscode';
import { LightchainNetwork, NetworkId, NETWORKS } from './networks';

const STATE_KEY = 'lightchain.network';

/** The network selected for the open project. Remembered per workspace. */
export class NetworkState implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<LightchainNetwork>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.updateContextKey();
	}

	get current(): LightchainNetwork {
		const id = this.context.workspaceState.get<NetworkId>(STATE_KEY, 'testnet');
		return NETWORKS[id] ?? NETWORKS.testnet;
	}

	async set(id: NetworkId): Promise<void> {
		if (id === this.current.id) {
			return;
		}
		await this.context.workspaceState.update(STATE_KEY, id);
		this.updateContextKey();
		this._onDidChange.fire(this.current);
	}

	private updateContextKey(): void {
		vscode.commands.executeCommand('setContext', 'lightchain.network', this.current.id);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
