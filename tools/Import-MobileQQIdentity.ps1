[CmdletBinding()]
param(
    [string]$AdbPath = "",
    [string]$OutputDirectory = "",
    [string]$PackageName = "com.tencent.mobileqq"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-AdbPath {
    param([string]$Requested)

    $fromPath = Get-Command adb.exe -ErrorAction SilentlyContinue
    $candidates = @(
        $Requested,
        $env:ADB,
        $(if ($fromPath) { $fromPath.Source }),
        (Join-Path $PSScriptRoot "adb.exe"),
        (Join-Path $PSScriptRoot "platform-tools\adb.exe")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "adb.exe was not found. Pass -AdbPath or add platform-tools to PATH."
}

function Invoke-AdbText {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & $script:Adb @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "adb failed: $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return ($output -join "`n").Trim()
}

function Invoke-RootShell {
    param([Parameter(Mandatory)][string]$Command)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    Invoke-AdbText @("-s", $serial, "shell", "su -c 'echo $encoded | base64 -d | sh'")
}

if ($PackageName -notmatch '^[A-Za-z0-9._]+$') {
    throw "Invalid Android package name."
}

$script:Adb = Resolve-AdbPath $AdbPath
$devices = @(& $script:Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice\s*$" })
if ($devices.Count -ne 1) {
    throw "Exactly one authorized Android device is required; found $($devices.Count)."
}
$serial = (($devices[0] -split "\s+")[0]).Trim()
$rootId = Invoke-RootShell "id"
if ($rootId -notmatch "uid=0\(root\)") {
    throw "The connected device does not provide root to adb shell."
}

if (-not $OutputDirectory) {
    $pluginRoot = Split-Path $PSScriptRoot -Parent
    $liteLoaderRoot = Split-Path (Split-Path $pluginRoot -Parent) -Parent
    $OutputDirectory = Join-Path $liteLoaderRoot "data\qqnt_mobile_restore\mobile-identity"
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$packagePaths = Invoke-AdbText @("-s", $serial, "shell", "pm", "path", $PackageName)
$baseApkLine = $packagePaths -split "`n" | Where-Object { $_ -match "base\.apk$" } | Select-Object -First 1
$baseApk = ($baseApkLine -replace "^package:", "").Trim()
if (-not $baseApk) { throw "Android package $PackageName is not installed." }
$installRoot = ($baseApk -replace "/base\.apk$", "")
$versionDump = Invoke-AdbText @("-s", $serial, "shell", "dumpsys", "package", $PackageName)
$versionName = [regex]::Match($versionDump, "versionName=([^\s]+)").Groups[1].Value
$versionCode = [regex]::Match($versionDump, "versionCode=(\d+)").Groups[1].Value
$abi = Invoke-AdbText @("-s", $serial, "shell", "getprop", "ro.product.cpu.abi")
$deviceManufacturer = Invoke-AdbText @("-s", $serial, "shell", "getprop", "ro.product.manufacturer")
$deviceModel = Invoke-AdbText @("-s", $serial, "shell", "getprop", "ro.product.model")

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteStage = "/data/local/tmp/qqnt_mobile_identity_$stamp"
$remoteArchive = "${remoteStage}.tar.gz"
$localArchive = Join-Path $OutputDirectory "mobile-identity-$stamp.tar.gz"
$currentArchive = Join-Path $OutputDirectory "mobile-identity-current.tar.gz"
$manifestPath = Join-Path $OutputDirectory "manifest.json"
$privateRoot = "/data/user/0/$PackageName"

$relativeSources = @(
    "files/nt_wtlogin",
    "files/msfCore",
    "files/qm",
    "files/com.tencent.qimei.sdk.QimeiSDK",
    "files/com.tencent.tbs.qimei.sdk.QimeiSDK",
    "files/highway_session_info_dir",
    "files/uid",
    "files/user",
    "shared_prefs/mobileQQ.xml",
    "shared_prefs/sp_login_auto.xml"
)

try {
    Invoke-RootShell "rm -rf $remoteStage $remoteArchive; mkdir -p $remoteStage/private $remoteStage/native" | Out-Null

    foreach ($source in $relativeSources) {
        $parent = ($source -replace '/[^/]+$', '')
        $command = "if [ -e $privateRoot/$source ]; then mkdir -p $remoteStage/private/$parent; cp -a $privateRoot/$source $remoteStage/private/$parent/; fi"
        Invoke-RootShell $command | Out-Null
    }

    $qimeiPrefsCommand = "mkdir -p $remoteStage/private/shared_prefs; cp -a $privateRoot/shared_prefs/*qimei* $remoteStage/private/shared_prefs/ 2>/dev/null || true"
    Invoke-RootShell $qimeiPrefsCommand | Out-Null

    foreach ($name in @("libfekit.so", "libpoxy.so", "libwtecdh.so", "libMSFKernel.so", "libkernel.so", "libmsfbootV2.so")) {
        $command = "src=`$(find $installRoot -type f -name $name 2>/dev/null | head -n 1); if [ -n `"`$src`" ]; then cp -a `"`$src`" $remoteStage/native/$name; fi"
        Invoke-RootShell $command | Out-Null
    }

    $deviceInfo = [ordered]@{
        schemaVersion = 1
        exportedAt = (Get-Date).ToUniversalTime().ToString("o")
        serial = $serial
        packageName = $PackageName
        versionName = $versionName
        versionCode = $versionCode
        abi = $abi
        deviceManufacturer = $deviceManufacturer
        deviceModel = $deviceModel
        deviceName = ((@($deviceManufacturer, $deviceModel) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " ").Trim()
        installRoot = $installRoot
    } | ConvertTo-Json -Depth 4 -Compress
    $deviceInfoBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($deviceInfo))
    Invoke-RootShell "echo $deviceInfoBase64 | base64 -d > $remoteStage/device.json; cd $remoteStage; tar -czf $remoteArchive ." | Out-Null

    $previousNativePreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $pullOutput = & $script:Adb -s $serial pull $remoteArchive $localArchive 2>&1
    $ErrorActionPreference = $previousNativePreference
    if ($LASTEXITCODE -ne 0) { throw "adb pull failed: $($pullOutput -join [Environment]::NewLine)" }
    Copy-Item -LiteralPath $localArchive -Destination $currentArchive -Force

    $manifest = [ordered]@{
        schemaVersion = 1
        importedAt = (Get-Date).ToUniversalTime().ToString("o")
        serial = $serial
        packageName = $PackageName
        versionName = $versionName
        versionCode = $versionCode
        abi = $abi
        deviceManufacturer = $deviceManufacturer
        deviceModel = $deviceModel
        deviceName = ((@($deviceManufacturer, $deviceModel) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " ").Trim()
        authenticatedUin = ""
        archive = $currentArchive
        archiveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $currentArchive).Hash.ToLowerInvariant()
        archiveBytes = (Get-Item -LiteralPath $currentArchive).Length
        mode = "offline-mobile-identity"
    }
    $authUins = Invoke-RootShell "cat $remoteStage/private/files/msfCore/.MSFSDKDataDir/.MSFAuthUin/.MSFAuthUinsV1.dat 2>/dev/null"
    $authCandidates = @([regex]::Matches($authUins, '\d{5,12}') | ForEach-Object { $_.Value } | Select-Object -Unique)
    $currentUin = if ($authCandidates.Count) { $authCandidates[0] } else { Invoke-RootShell "find $remoteStage/private/files/user -maxdepth 1 -type f -name 'u_*_t' -printf '%f\n' 2>/dev/null | sed -n 's/^u_\([0-9][0-9]*\)_t$/\1/p' | head -n 1" }
    $uinCandidates = Invoke-RootShell "find $remoteStage/private/files/uid -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sed -n 's/###.*//p'"
    $uins = @($uinCandidates -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{5,12}$' } | Select-Object -Unique)
    if ($currentUin.Trim() -match '^\d{5,12}$') {
        $manifest.authenticatedUin = $currentUin.Trim()
    } elseif ($uins.Count -eq 1) {
        $manifest.authenticatedUin = $uins[0]
    } elseif ($uins.Count -gt 1) {
        $manifest.authenticatedUin = $uins[0]
        $manifest.authenticatedUins = $uins
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    $manifest | ConvertTo-Json -Depth 5 -Compress
}
finally {
    try { Invoke-RootShell "rm -rf $remoteStage $remoteArchive" | Out-Null } catch {}
}
