$ErrorActionPreference = "Stop"

# Always run relative to this script's own directory.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

# Keep this script source ASCII-only so Windows PowerShell 5.1 can run it
# even when the file is saved as UTF-8 without BOM.
$listFileName = (-join ([char[]](0x6587, 0x4EF6, 0x5217, 0x8868))) + ".txt"
$outputFile = Join-Path $scriptDir $listFileName

$aiFiles = Get-ChildItem -LiteralPath $scriptDir -File -Filter "*.ai" |
    Sort-Object -Property LastWriteTime

$paths = @()
foreach ($file in $aiFiles) {
    $paths += $file.FullName.Replace("\", "/")
}

# UTF-8 output. Windows PowerShell writes UTF-8 with BOM; PowerShell 7 writes UTF-8 without BOM.
Set-Content -LiteralPath $outputFile -Value $paths -Encoding UTF8

if ($aiFiles.Count -eq 0) {
    Write-Host ("No .ai files found in the current directory. Created empty {0}." -f $listFileName)
} else {
    Write-Host ("Created {0}. Found {1} .ai file(s)." -f $listFileName, $aiFiles.Count)
}
