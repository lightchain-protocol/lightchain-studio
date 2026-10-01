import { defineChain } from 'viem';

export type NetworkId = 'testnet' | 'mainnet';

export interface LightchainNetwork {
	id: NetworkId;
	label: string;
	chainId: number;
	rpcUrl: string;
	explorerUrl: string;
	/** JobRegistry — holds prepaid inference credits (prepaidBalanceOf). */
	jobRegistry: `0x${string}`;
	/** consumer-api (SIWE auth, sessions, delegated job submission). */
	consumerApiUrl: string;
	/** Relay WebSocket that streams encrypted inference output. */
	relayUrl: string;
}

// Verified live 2026-10-01 (eth_chainId + explorer). docs.lightchain.ai lists
// testnet-explorer.lightchain.ai, which does not resolve; lightscan.app is correct.
export const NETWORKS: Record<NetworkId, LightchainNetwork> = {
	testnet: {
		id: 'testnet',
		label: 'Testnet',
		chainId: 8200,
		rpcUrl: 'https://rpc.testnet.lightchain.ai',
		explorerUrl: 'https://testnet.lightscan.app',
		// lcai-chat-v2 config/index.ts (testnet default); verified prepaidBalanceOf live 2026-10-01
		jobRegistry: '0x531b3A87c5D785441B9cF55b98169F20FD9056a7',
		consumerApiUrl: 'https://chat-api.testnet.lightchain.ai',
		relayUrl: 'wss://relay.testnet.lightchain.ai/ws', // consumer-api manifest.json
	},
	mainnet: {
		id: 'mainnet',
		label: 'Mainnet',
		chainId: 9200,
		rpcUrl: 'https://rpc.mainnet.lightchain.ai',
		explorerUrl: 'https://mainnet.lightscan.app',
		// lcai-chat-v2 config/index.ts (source-pinned mainnet); matches docs /mainnet/contracts
		jobRegistry: '0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b',
		consumerApiUrl: 'https://chat-api.mainnet.lightchain.ai',
		relayUrl: 'wss://relay.mainnet.lightchain.ai/ws', // docs.lightchain.ai mainnet network page
	},
};

export function toViemChain(network: LightchainNetwork) {
	return defineChain({
		id: network.chainId,
		name: `Lightchain ${network.label}`,
		nativeCurrency: { name: 'LightchainAI', symbol: 'LCAI', decimals: 18 },
		rpcUrls: { default: { http: [network.rpcUrl] } },
		blockExplorers: { default: { name: 'Lightscan', url: network.explorerUrl } },
	});
}

export function addressUrl(network: LightchainNetwork, address: string): string {
	return `${network.explorerUrl}/address/${address}`;
}

export function txUrl(network: LightchainNetwork, hash: string): string {
	return `${network.explorerUrl}/tx/${hash}`;
}
