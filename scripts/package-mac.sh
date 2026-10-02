#!/usr/bin/env bash
# Builds Lightchain Studio for macOS and wraps it in a DMG.
#
#   ./scripts/package-mac.sh [arm64|x64]
#
# Signing and notarization run only when these are set (otherwise the DMG is
# unsigned and macOS asks users to right-click → Open the first time):
#   APPLE_SIGN_IDENTITY   "Developer ID Application: <Org> (<TEAMID>)"
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   (app-specific password for notarytool)
set -euo pipefail

ARCH="${1:-$(uname -m | sed 's/x86_64/x64/')}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(dirname "$ROOT")/VSCode-darwin-$ARCH"
APP="$OUT/Lightchain Studio.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DMG="$(dirname "$ROOT")/LightchainStudio-$VERSION-$ARCH.dmg"

cd "$ROOT"
npm run gulp "vscode-darwin-$ARCH-min"

if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
	echo "Signing with $APPLE_SIGN_IDENTITY"
	# Code - OSS signer: hardened runtime + per-helper entitlements (build/azure-pipelines/darwin/*.plist)
	VSCODE_ARCH="$ARCH" CODESIGN_IDENTITY="$APPLE_SIGN_IDENTITY" node build/darwin/sign.ts "$(dirname "$ROOT")"
	codesign --verify --deep --strict "$APP"
fi

STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Lightchain Studio" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
	codesign --sign "$APPLE_SIGN_IDENTITY" --timestamp "$DMG"
	if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
		echo "Notarizing…"
		xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
		xcrun stapler staple "$DMG"
	fi
fi

echo "Done: $DMG"
