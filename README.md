<p align="center">
  <img src="docs/images/lightchain-mark.png" width="128" alt="Lightchain Studio">
</p>

<h1 align="center">Lightchain Studio</h1>

<p align="center">
  The official IDE for <a href="https://lightchain.ai">Lightchain AI</a>.<br>
  Write, test and deploy smart contracts with a private AI agent, a wallet and the Lightscan explorer built in.
</p>

<p align="center">
  <a href="https://github.com/lightchain-protocol/lightchain-studio/releases/latest"><img src="https://img.shields.io/github/v/release/lightchain-protocol/lightchain-studio?label=download&color=7C3AED" alt="Latest release"></a>
  <a href="https://github.com/lightchain-protocol/lightchain-studio/actions/workflows/build.yml"><img src="https://github.com/lightchain-protocol/lightchain-studio/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="https://docs.lightchain.ai"><img src="https://img.shields.io/badge/docs-lightchain.ai-F020E0" alt="Docs"></a>
</p>

---

Lightchain Studio is built on [Code - OSS](https://github.com/microsoft/vscode), so it is the editor you already know: the same keybindings, settings, themes and extensions from [Open VSX](https://open-vsx.org). On top of that it adds a Lightchain workspace. The only AI that ships with it is Lightchain AI. No Copilot, no telemetry, no auto-update.

## Download

| | Platform | Package |
|:-:|---|---|
| 🍎 | macOS, Apple Silicon | `LightchainStudio-<version>-macOS-AppleSilicon.dmg` |
| 🍎 | macOS, Intel | `LightchainStudio-<version>-macOS-Intel.dmg` |
| 🪟 | Windows 10 / 11, x64 | `LightchainStudio-<version>-Windows-x64-Setup.exe` (installer) or `-Portable.zip` |
| 🐧 | Linux, x64 | `LightchainStudio-<version>-Linux-x64.tar.gz` |

All builds are on the [Releases](https://github.com/lightchain-protocol/lightchain-studio/releases) page. The macOS DMG is unsigned unless a release was signed with an Apple Developer ID. If macOS blocks it, right-click the app and choose **Open** once.

## What's inside

**Lightchain AI agent.** Runs on Lightchain's decentralized inference network. Prompts are encrypted end to end and served by Lightchain workers, so no central party sees your code. The agent reads your project, writes and edits files, and runs `forge build`. Every change is an inline diff you **Accept** or **Reject**, hunk by hunk. Pick any model the network serves and see live worker availability.

**Wallet.** Connect a browser wallet (MetaMask, Rabby, Coinbase, Brave and others) through a local bridge page, with no WalletConnect project ID required. Or keep local accounts in the OS keychain: create one, import a private key or recovery phrase, or export an account as a Foundry keystore.

**Credits.** Top up and withdraw Lightchain AI credits (LCAI held in the JobRegistry contract) from the wallet menu or the status bar.

**Deployed Programs.** A side bar listing every contract from your Foundry broadcasts, per project and per network. Contracts referenced in your code are marked. Open any contract on Lightscan, or **Interact** with its read and write functions in a tab. Reads load live values. Writes are simulated before you sign.

**Foundry built in.** *Lightchain: Build*, *Test* and *Deploy Script* run `forge` with compiler errors in the Problems panel. Deploys are signed by your Lightchain wallet through a local signing proxy, so forge never sees a private key. Contracts can be verified on Lightscan. If Foundry is missing, the IDE offers to install it.

**New Lightchain Project.** Scaffolds a Foundry project (contract, test and deploy script) set up for Lightchain.

**Extensions.** A curated Lightchain Marketplace section plus Open VSX for regular VS Code extensions.

**Lightchain design.** The theme, fonts and start page follow lightchain.ai.

## Getting started

1. **Open or create a project.** On the Start page choose *New Project*, *Open Folder* or *Clone Repository*.
2. **Connect a wallet.** Click **Connect Wallet** in the status bar (bottom left).
   - *Connect Browser Wallet* opens a local page at `http://localhost:3000` where you pick your browser wallet once. Keep the tab open: signing requests from the IDE appear there and in your wallet.
   - Or *Create Account*, *Import Private Key* or *Import Recovery Phrase* for a local account.
3. **Get testnet LCAI** from the [Lightchain faucet](https://lightfaucet.ai), linked from the Start page.
4. **Top up credits.** Click the status bar, then *Top Up Credits*. On your first prompt Lightchain AI asks once for permission to spend credits.
5. **Ask Lightchain AI.** Type in the panel on the right, for example *Create an ERC-20 token with a deploy script*. Review each proposed change and accept or reject it.
6. **Build, test, deploy.** Run *Lightchain: Build*, *Lightchain: Test* and *Lightchain: Deploy Script* from the Command Palette. Deployed contracts appear in **Deployed Programs**.
7. **Switch networks** from the Deployed Programs header, or with *Lightchain: Switch to Mainnet* / *Switch to Testnet*.

### Networks

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 8200 | 9200 |
| RPC | `https://rpc.testnet.lightchain.ai` | `https://rpc.mainnet.lightchain.ai` |
| Explorer | https://testnet.lightscan.app | https://mainnet.lightscan.app |

Network settings live in [`extensions/lightchain-studio/src/networks.ts`](extensions/lightchain-studio/src/networks.ts).

## Privacy and security model

- **Prompts are encrypted end to end.** A session key is sealed to one sortition-selected worker (P-256 ECDH + AES-256-GCM). Each prompt is uploaded as an encrypted blob and paid from prepaid credits. Answers stream back over a relay WebSocket and are decrypted in the IDE.
- **Keys never leave the keychain.** Local accounts live in the OS secret store. Signing happens in-process. Exporting a key or sending a mainnet transaction always asks first.
- **Forge never holds a key.** Deploys go through a loopback JSON-RPC proxy that only signs `eth_sendTransaction` for the active account and refuses browser-originated requests.
- **The wallet bridge is loopback only.** It binds to `127.0.0.1`, checks the `Host` and `Origin` headers, and requires a random per-install token.
- **Every file write and shell command needs your approval.** The agent can read and search the workspace on its own. Writes, edits and commands show an approval card first.
- **No telemetry.** Product telemetry and automatic updates are off by default.

## Build from source

### Requirements

- Node.js **24** (see `.nvmrc`) and Python 3
- Platform build tools for native modules:
  - macOS: Xcode Command Line Tools
  - Linux: `build-essential`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev`
  - Windows: Visual Studio 2022 Build Tools with the *Desktop development with C++* workload **and** the *MSVC Spectre-mitigated libraries* component
- [Foundry](https://getfoundry.sh) for building and deploying contracts

### Run from source

```sh
git clone https://github.com/lightchain-protocol/lightchain-studio.git
cd lightchain-studio
npm install          # IDE and built-in extension dependencies
npm run compile      # compile the IDE
./scripts/code.sh    # macOS / Linux
scripts\code.bat     # Windows
```

Pass a folder to open it directly: `./scripts/code.sh path/to/project`.

> **Windows note.** If you launch from a terminal inside VS Code, clear `ELECTRON_RUN_AS_NODE` first (`set ELECTRON_RUN_AS_NODE=`), otherwise Electron starts as plain Node.

### Package a release

```sh
./scripts/package-mac.sh arm64                 # macOS DMG (x64 for Intel)
npm run gulp vscode-linux-x64-min              # Linux   → ../VSCode-linux-x64
npm run gulp vscode-win32-x64-min              # Windows → ../VSCode-win32-x64
npm run gulp vscode-win32-x64-inno-updater     # then the installer:
npm run gulp vscode-win32-x64-user-setup       # Windows installer (.build/win32-x64/user-setup)
```

Signed and notarized macOS builds need `APPLE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` in the environment.

The [release workflow](.github/workflows/release.yml) builds all platforms and publishes them to a GitHub Release whenever a `v*` tag is pushed.

### The Lightchain extension

All Lightchain features live in [`extensions/lightchain-studio`](extensions/lightchain-studio). Its compiled bundle (`dist/extension.js`) is committed, so the IDE runs right after `npm run compile`. After changing its sources in `src/`:

```sh
cd extensions/lightchain-studio/tools
npm install
npm run typecheck
npm test
npm run build        # ../src → ../dist/extension.js
```

Then run *Developer: Reload Window*.

## Project layout

| Path | What it is |
|---|---|
| `extensions/lightchain-studio/src/lightchain/` | Lightchain AI client: SIWE sign-in, sortition, session keys, encrypted blobs, relay streaming |
| `extensions/lightchain-studio/src/agent/` | The coding agent loop, its tools and the diff preview |
| `extensions/lightchain-studio/src/aiView.ts` | The Lightchain AI panel |
| `extensions/lightchain-studio/src/wallet.ts`, `browserBridge.ts`, `connectPage.ts`, `keystore.ts` | Local accounts and the browser wallet bridge |
| `extensions/lightchain-studio/src/credits.ts` | JobRegistry deposit, withdraw and allowance |
| `extensions/lightchain-studio/src/deployedPrograms.ts`, `interact.ts` | Deployed Programs view and contract interaction |
| `extensions/lightchain-studio/src/foundry.ts`, `signingProxy.ts` | Forge tasks and the local signing proxy |
| `extensions/hardhat-solidity/` | Solidity language support, vendored from Nomic Foundation (MIT) |
| `extensions/theme-lightchain/` | The Lightchain Dark theme |
| `extensions/lightchain-defaults/` | Privacy-first default settings |
| `product.json` | Product identity, hidden built-ins, gallery configuration |

Changes to the upstream editor are kept deliberately small: branding, default settings, removing Copilot, and hiding third-party AI assistants from the Extensions view. Everything else is standard Code - OSS, which keeps the fork easy to rebase.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and submit changes, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE.txt](LICENSE.txt). Third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt). Code - OSS is Copyright (c) Microsoft Corporation and licensed under MIT.
