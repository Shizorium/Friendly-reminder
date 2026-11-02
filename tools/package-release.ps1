# Build an installable Foundry archive without external dependencies.
$ErrorActionPreference = 'Stop'

$moduleRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $moduleRoot 'module.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $moduleRoot 'package.json') -Raw | ConvertFrom-Json
$repoUrl = 'https://github.com/Shizorium/Friendly-reminder'

if ($manifest.id -ne 'friendly-reminder' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Invalid module ID or release version.'
}
if ($manifest.version -ne $package.version) {
    throw 'module.json and package.json versions must match.'
}
if ($manifest.manifest -ne "$repoUrl/releases/latest/download/module.json") {
    throw 'The manifest must use the permanent latest-release URL.'
}
if ($manifest.download -ne "$repoUrl/releases/download/v$($manifest.version)/friendly-reminder.zip") {
    throw 'The download URL must match this release version.'
}

$files = @('module.json', 'README.md', 'CHANGELOG.md', 'LICENSE')
foreach ($directory in @('scripts', 'styles', 'lang')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $moduleRoot $directory) -File -Recurse) {
        $files += $file.FullName.Substring($moduleRoot.Length + 1).Replace('\', '/')
    }
}
foreach ($relative in @($manifest.esmodules) + @($manifest.styles) + @($manifest.languages | ForEach-Object { $_.path })) {
    if ($files -notcontains $relative -or -not (Test-Path -LiteralPath (Join-Path $moduleRoot $relative) -PathType Leaf)) {
        throw "Missing module file: $relative"
    }
}

$output = Join-Path $moduleRoot 'dist'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archivePath = Join-Path $output 'friendly-reminder.zip'
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $files | Sort-Object) {
            $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $bytes = [System.IO.File]::ReadAllBytes((Join-Path $moduleRoot $relative))
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally { $entryStream.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $output 'module.json') -Force
Write-Output "Friendly reminder $($manifest.version): $archivePath"
Write-Output "Manifest: $(Join-Path $output 'module.json')"
