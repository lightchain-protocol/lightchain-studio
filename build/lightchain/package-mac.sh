#!/usr/bin/env bash
# Builds Lightchain Studio for macOS and wraps it in a DMG.
#
#   ./build/lightchain/package-mac.sh [arm64|x64]
#
# Output: build/lightchain/out/LightchainStudio-<version>-darwin-<arch>.dmg (+ .sha256)
#
# Signing and notarization run only when these are set (otherwise the DMG is
# unsigned and macOS asks users to right-click → Open the first time):
#   APPLE_SIGN_IDENTITY   "Developer ID Application: <Org> (<TEAMID>)"
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   (app-specific password for notarytool)
set -euo pipefail

ARCH="${1:-$(uname -m | sed 's/x86_64/x64/')}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${APP_DIR:-$(dirname "$ROOT")/VSCode-darwin-$ARCH}"
APP="$OUT/Lightchain Studio.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DMG="$HERE/out/LightchainStudio-$VERSION-darwin-$ARCH.dmg"
mkdir -p "$HERE/out"

cd "$ROOT"
# SKIP_BUILD=1 wraps an app that is already built (APP_DIR points at the folder holding it)
if [[ -z "${SKIP_BUILD:-}" ]]; then
	npm run gulp "vscode-darwin-$ARCH-min"
fi

if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
	echo "Signing with $APPLE_SIGN_IDENTITY"
	# Code - OSS signer: hardened runtime + per-helper entitlements (build/azure-pipelines/darwin/*.plist)
	VSCODE_ARCH="$ARCH" CODESIGN_IDENTITY="$APPLE_SIGN_IDENTITY" node build/darwin/sign.ts "$(dirname "$ROOT")"
else
	# Without a certificate the bundle still needs a signature that matches its contents:
	# a downloaded app whose ad-hoc signature is stale reads as "damaged" with no way past it.
	# Re-signed ad hoc, macOS asks once whether to open an app from an unidentified developer.
	echo "Signing ad hoc (no APPLE_SIGN_IDENTITY)"
	codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

# The install window, branded like the Lightchain P2P app's: the dark page with the mark,
# one line of instruction and the gradient arrow (dmg-background.py); the icons sit at its ends.
# Laid out by Finder on a writable image, then compressed. If Finder cannot be scripted
# (no permission, no window server) the image is still correct, just unstyled.
rm -f "$DMG"
VOLUME="Lightchain Studio"
STAGE="$(mktemp -d)"
WORK="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir "$STAGE/.background"
tiffutil -cathidpicheck "$HERE/dmg-background.png" "$HERE/dmg-background@2x.png" -out "$STAGE/.background/background.tiff" >/dev/null
# room for the file system itself: thousands of small files cost more than their size
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) * 13 / 10 + 120 ))
hdiutil create -volname "$VOLUME" -srcfolder "$STAGE" -fs HFS+ -format UDRW -size "${SIZE_MB}m" "$WORK/rw.dmg" >/dev/null
rm -rf "$STAGE"
MOUNT="$(hdiutil attach -readwrite -noverify -noautoopen "$WORK/rw.dmg" | awk -F '\t' '/\/Volumes\//{print $NF}' | tail -1)"
if ! perl -e 'alarm 90; exec @ARGV' osascript <<APPLESCRIPT
tell application "Finder"
	tell disk "$(basename "$MOUNT")"
		open
		set current view of container window to icon view
		set toolbar visible of container window to false
		set statusbar visible of container window to false
		set bounds of container window to {200, 120, 860, 568}
		set opts to the icon view options of container window
		set arrangement of opts to not arranged
		set icon size of opts to 112
		set text size of opts to 13
		set background picture of opts to file ".background:background.tiff"
		set position of item "Lightchain Studio.app" of container window to {170, 250}
		set position of item "Applications" of container window to {490, 250}
		close
		open
		update without registering applications
		delay 2
		close
	end tell
end tell
APPLESCRIPT
then
	echo "Finder could not lay out the install window; the disk image is left unstyled"
fi
sync
hdiutil detach "$MOUNT" >/dev/null || hdiutil detach -force "$MOUNT" >/dev/null
hdiutil convert "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
rm -rf "$WORK"

if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
	codesign --sign "$APPLE_SIGN_IDENTITY" --timestamp "$DMG"
	if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
		echo "Notarizing…"
		xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
		xcrun stapler staple "$DMG"
	fi
fi

(cd "$HERE/out" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "Done: $DMG"
