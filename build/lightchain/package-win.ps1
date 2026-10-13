# Builds Lightchain Studio for Windows: a user installer and a portable zip.
#
#   .\build\lightchain\package-win.ps1 [x64|arm64]
#
# Run on Windows (the native modules are compiled for the host), after `npm ci`.
# Output: build\lightchain\out\LightchainStudioSetup-<version>-win32-<arch>.exe
#         build\lightchain\out\LightchainStudio-<version>-win32-<arch>.zip  (+ .sha256)
#
# The installer is unsigned, so Windows SmartScreen asks users to confirm
# (More info → Run anyway) until it is signed with a code signing certificate.
param([ValidateSet('x64', 'arm64')][string]$Arch = 'x64')

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $Here '..\..')).Path
$Out = Join-Path $Here 'out'
$App = Join-Path (Split-Path $Root -Parent) "VSCode-win32-$Arch"
$Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version

function Invoke-Gulp([string]$Task) {
	npm run gulp $Task
	if ($LASTEXITCODE -ne 0) { throw "gulp $Task failed ($LASTEXITCODE)" }
}

Push-Location $Root
try {
	Invoke-Gulp "vscode-win32-$Arch-min"
	Invoke-Gulp "vscode-win32-$Arch-inno-updater"
	Invoke-Gulp "vscode-win32-$Arch-user-setup"
} finally {
	Pop-Location
}

New-Item -ItemType Directory -Force $Out | Out-Null
$Setup = Join-Path $Out "LightchainStudioSetup-$Version-win32-$Arch.exe"
$Zip = Join-Path $Out "LightchainStudio-$Version-win32-$Arch.zip"
Copy-Item (Join-Path $Root ".build\win32-$Arch\user-setup\VSCodeSetup.exe") $Setup -Force

# Portable zip: the app folder without the installer-only tools
Remove-Item $Zip -ErrorAction SilentlyContinue
Get-ChildItem $App -Exclude 'tools' | Compress-Archive -DestinationPath $Zip -CompressionLevel Optimal

foreach ($File in $Setup, $Zip) {
	$Hash = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
	"$Hash  $(Split-Path $File -Leaf)" | Set-Content "$File.sha256" -Encoding ascii
}

Write-Host "Done: $Setup"
Write-Host "Done: $Zip"
