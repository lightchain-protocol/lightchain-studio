# Lightchain Studio

The official IDE for Lightchain AI. Write, test and deploy smart contracts, with Lightchain AI, a wallet and the Lightscan explorer built in.

Lightchain Studio is built on [Code - OSS](https://github.com/microsoft/vscode) (MIT). It keeps the editor you know and adds a Lightchain workspace. The only AI built in is Lightchain AI; no Copilot or other assistants ship with it.

## Features

- **Lightchain AI agent.** It runs on Lightchain's decentralized inference: prompts are encrypted end to end and served by Lightchain workers. The agent reads your project, writes and edits files, and runs `forge build`. Every change is shown as an inline diff that you **Accept** or **Reject** (⌘⏎ accepts). Pick any model the network serves (Llama, Qwen, GPT-OSS…) and see live worker availability.
- **Credits.** Top up and withdraw Lightchain AI credits (LCAI held in the JobRegistry contract) from the wallet menu or the status bar.
- **Wallet.**
  - Use your browser wallet (MetaMask, Rabby, Coinbase, Brave…) through a local bridge page. No WalletConnect project ID is needed.
  - Or keep local accounts in the OS keychain: create one, import a private key or recovery phrase, or export an account as a Foundry keystore.
- **Deployed Programs** (right side bar), per project and per network, testnet or mainnet:
  - Lists every contract from your Foundry broadcasts, your deployer address and manual entries.
  - ✓ marks contracts referenced anywhere in your code.
  - Open any contract on Lightscan.
  - **Interact** opens a tab with the contract's read and write functions. Reads load live values; writes are simulated before you sign.
- **Foundry built in.** *Lightchain: Build*, *Test* and *Deploy Script* run `forge` with compiler errors in Problems. Deploys are signed by your Lightchain wallet; forge never sees the key. Contracts can be verified on Lightscan.
- **New Lightchain Project.** Scaffolds a Foundry project (contract, test and deploy script) set up for Lightchain.
- **Extensions.** A curated Lightchain Marketplace section plus [Open VSX](https://open-vsx.org) for regular VS Code extensions.
- **Lightchain design.** The theme, fonts and start page follow lightchain.ai.

## Requirements

- macOS (arm64 or x64), Linux or Windows
- Node.js **24** (see `.nvmrc`) and Python 3
- Platform build tools for native modules: Xcode Command Line Tools on macOS, `build-essential` on Linux, VS Build Tools on Windows
- [Foundry](https://getfoundry.sh) for building and deploying contracts. If it's missing, the IDE offers to install it.

## Build and run

```sh
git clone https://github.com/lightchain-protocol/lightchain-studio.git
cd lightchain-studio
npm install          # installs dependencies for the IDE and its built-in extensions
npm run compile      # compiles the IDE
./scripts/code.sh    # launches Lightchain Studio from source (scripts\code.bat on Windows)
```

To open a project directly, run `./scripts/code.sh path/to/project`.

### Packaged app

```sh
npm run gulp vscode-darwin-arm64-min   # → ../VSCode-darwin-arm64/Lightchain Studio.app
# other targets: vscode-darwin-x64-min, vscode-linux-x64-min, vscode-win32-x64-min
```

### Lightchain extension

The Lightchain features live in `extensions/lightchain-studio`. The compiled bundle (`dist/extension.js`) is committed, so the IDE runs right after `npm run compile`. After changing its TypeScript sources, rebuild it:

```sh
cd extensions/lightchain-studio
npm install
npm run build        # src/ → dist/extension.js
```

Then reload the window (*Developer: Reload Window*).

## Using Lightchain Studio

1. **Open or create a project.** On the Start page, choose *New Project*, *Open Folder* or *Clone Repository*.
2. **Connect a wallet.** Click **Connect Wallet** in the status bar (bottom left).
   - *Connect Browser Wallet* opens a local page (`http://localhost:3000`) where you pick your browser wallet once. Keep the tab open; signing requests from the IDE appear there and in your wallet.
   - Or *Create Account*, *Import Private Key* or *Import Recovery Phrase* for a local account.
3. **Get testnet LCAI.** Use the [Lightchain faucet](https://lightfaucet.ai), linked from the Start page.
4. **Top up credits.** Click the status bar, then *Top Up Credits*. On your first prompt, Lightchain AI asks once for permission to spend your credits; approve it and your message is sent automatically.
5. **Ask Lightchain AI.** Type in the panel on the right, for example: *Create an ERC-20 token with a deploy script*. Review each proposed file change and accept or reject it.
6. **Build, test, deploy.** Use *Lightchain: Build*, *Lightchain: Test* and *Lightchain: Deploy Script* from the Command Palette (⇧⌘P). Deployed contracts appear in **Deployed Programs**; use **Interact** to call them.
7. **Switch networks.** Use the network switch in the Deployed Programs header, or run *Lightchain: Switch to Mainnet* or *Lightchain: Switch to Testnet*.

### Networks

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 8200 | 9200 |
| RPC | `https://rpc.testnet.lightchain.ai` | `https://rpc.mainnet.lightchain.ai` |
| Explorer | https://testnet.lightscan.app | https://mainnet.lightscan.app |

Network settings live in `extensions/lightchain-studio/src/networks.ts`.

## How it works

- **The IDE** is Code - OSS with the Lightchain identity, theme, layout defaults and built-in extensions configured in `product.json`. Upstream AI features (Copilot, chat agents) are disabled, and third-party AI extensions are hidden from Extensions search.
- **`extensions/lightchain-studio`** is the Lightchain built-in extension:
  - `src/lightchain/`: the Lightchain AI client.
    - Sign-in: SIWE → JWT.
    - Session: sortition picks a worker, and a session key is sealed to that worker (P-256 ECDH + AES-256-GCM).
    - Each prompt is uploaded as an encrypted blob and submitted as a job paid from prepaid credits.
    - Answers stream back over the relay WebSocket and are decrypted in the IDE.
  - `src/agent/`: the coding agent loop, its tools (read, search, write/edit with approval, `forge build`, commands with approval) and the diff preview.
  - `src/aiView.ts`: the Lightchain AI panel.
  - `src/wallet.ts`, `src/browserBridge.ts`, `src/connectPage.ts`, `src/keystore.ts`: local accounts in SecretStorage, and the browser wallet bridge. The bridge is a loopback page that discovers wallets through EIP-6963 and relays requests over SSE/POST, protected by a token plus Host and Origin checks.
  - `src/credits.ts`: JobRegistry deposit, withdraw and delegate allowance.
  - `src/deployedPrograms.ts`, `src/interact.ts`: the Deployed Programs view and contract interaction.
  - `src/foundry.ts`, `src/signingProxy.ts`: forge tasks. Deploys go through a local JSON-RPC proxy, so the Lightchain wallet signs and forge never holds the key.
- **`extensions/hardhat-solidity`**: Solidity language support, vendored from Nomic Foundation (MIT).
- **`extensions/theme-lightchain`**: the Lightchain Dark theme.

## License

MIT. See `LICENSE.txt`. Third-party notices are in `ThirdPartyNotices.txt`.
