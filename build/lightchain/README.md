# Lightchain Studio release builds

Scripts that turn this repository into the files people download. Everything they produce lands in `build/lightchain/out/` (ignored by git).

| Platform | Script | Output |
|---|---|---|
| macOS (Apple silicon, Intel) | `./build/lightchain/package-mac.sh [arm64\|x64]` | `LightchainStudio-<version>-darwin-<arch>.dmg` |
| Windows (x64, arm64) | `.\build\lightchain\package-win.ps1 [x64\|arm64]` | `LightchainStudioSetup-<version>-win32-<arch>.exe` (installer) and `LightchainStudio-<version>-win32-<arch>.zip` (portable) |

The DMG opens as a branded install window (drag the app onto Applications), laid out by Finder from `dmg-background.png`; regenerate that with `dmg-background.py`. If Finder cannot be scripted on the build machine, the image is still valid, just unstyled. Without a signing identity the app is re-signed ad hoc, so a downloaded copy opens after one confirmation instead of reading as damaged.

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

- **macOS.** Add these repository secrets and the Release workflow signs and notarizes the app: `APPLE_CERT_P12_BASE64` (your Developer ID Application certificate exported as .p12, base64-encoded), `APPLE_CERT_PASSWORD`, `APPLE_SIGN_IDENTITY` (`Developer ID Application: <Org> (<TEAMID>)`), `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` (an app-specific password). Without them the app is signed ad hoc, which has two visible costs:
  - macOS asks users to confirm the first launch (System Settings → Privacy & Security → **Open Anyway**).
  - Wallet keys live in the macOS keychain, and an ad-hoc signature is a new identity on every build, so after each update macOS asks for the login password before Lightchain Studio may read its own keychain entry (*"wants to use your confidential information stored in Lightchain Studio Safe Storage"*). **Always Allow** silences it until the next update; a Developer ID signature removes it for good.
- **Windows.** The installer is not signed yet, so SmartScreen shows *Windows protected your PC*; users choose *More info → Run anyway*. Signing needs a code signing certificate.
