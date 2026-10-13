# Lightchain Studio release builds

Scripts that turn this repository into the files people download. Everything they produce lands in `build/lightchain/out/` (ignored by git).

| Platform | Script | Output |
|---|---|---|
| macOS (Apple silicon, Intel) | `./build/lightchain/package-mac.sh [arm64\|x64]` | `LightchainStudio-<version>-darwin-<arch>.dmg` |
| Windows (x64, arm64) | `.\build\lightchain\package-win.ps1 [x64\|arm64]` | `LightchainStudioSetup-<version>-win32-<arch>.exe` (installer) and `LightchainStudio-<version>-win32-<arch>.zip` (portable) |

Each file gets a `.sha256` next to it. The version comes from the root `package.json`.

Build each platform on that platform: the native modules are compiled for the machine that runs `npm ci`, so a Windows build made on a Mac would not start. Run `npm ci` first, and rebuild the Lightchain extension if its sources changed (see the main README).

## Cutting a release

1. Merge what should ship into `main`.
2. Tag it and push the tag:
   ```sh
   git tag v1.139.1 && git push origin v1.139.1
   ```
3. The **Release** workflow (`.github/workflows/release.yml`) builds macOS arm64, macOS x64 and Windows x64, then creates a **draft** GitHub release with the DMGs, the installer, the zip and `SHA256SUMS.txt`.
4. Open the draft under *Releases*, check the notes, and publish it.

The workflow can also be run by hand (*Actions → Release → Run workflow*). Without a tag it only builds the files and keeps them as workflow artifacts.

## Signing

- **macOS.** Set the repository secrets `APPLE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` to sign and notarize (the certificate must be in the runner's keychain). Without them the DMG is unsigned and macOS asks users to right-click → **Open** the first time.
- **Windows.** The installer is not signed yet, so SmartScreen shows *Windows protected your PC*; users choose *More info → Run anyway*. Signing needs a code signing certificate.
