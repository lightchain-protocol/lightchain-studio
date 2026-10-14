# Contributing to Lightchain Studio

Thanks for helping build the Lightchain IDE. This guide covers the things that are specific to this repository. For anything about the editor itself, the upstream [Code - OSS contribution guide](https://github.com/microsoft/vscode/blob/main/CONTRIBUTING.md) applies.

## Where things live

- **Lightchain features**: `extensions/lightchain-studio`. This is where almost all changes go.
- **Product identity and defaults**: `product.json`, `extensions/lightchain-defaults`, `extensions/theme-lightchain`.
- **Editor changes**: kept to a minimum so the fork stays easy to rebase on upstream. If you need to touch `src/vs`, keep the diff small and leave a `// Lightchain Studio:` comment explaining why.

## Set up

```sh
npm install
npm run compile
./scripts/code.sh        # or scripts\code.bat on Windows
```

See the [README](README.md#build-from-source) for platform prerequisites.

## Working on the extension

```sh
cd extensions/lightchain-studio/tools
npm install
npm run typecheck
npm test
npm run build            # rebuilds ../dist/extension.js
```

The built `dist/extension.js` is committed. Always rebuild it and include it in your pull request when you change anything under `src/`. CI checks that the bundle is up to date.

Tests live in `extensions/lightchain-studio/test` and run on Node's built-in test runner against a small `vscode` mock. Add a test for any change to the agent loop, diff application or chat store.

## Pull requests

- One topic per PR. Keep refactors separate from behaviour changes.
- Describe what changed and why. Screenshots or a short recording help for UI work.
- Do not commit secrets, keystores or `.env` files. The wallet code is reviewed carefully; changes that touch key handling, signing, the browser bridge or the signing proxy must explain their security impact.
- Run `npm run typecheck` and `npm test` in `extensions/lightchain-studio/tools` before pushing.

## Reporting bugs

Open an issue with the version (Help → About), your OS, the steps to reproduce and what you expected. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing you agree that your contributions are licensed under the MIT License, the same as the rest of the project.
