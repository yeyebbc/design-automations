<#
.SYNOPSIS
Stages .afdesign files on a specified Desktop for the Affinity batch exporter.

.DESCRIPTION
SourcePath and DesktopPath are required so the same script can be used on
Windows and macOS. Absolute paths in the list may use Windows, UNC, or POSIX
syntax; their file names are resolved below SourcePath. Relative list entries
are resolved below SourcePath and may retain relative subdirectories. Output
lists contain at most 150 files and are numbered _001, _002, and so on.

.EXAMPLE
./Affinity_Stage_Source_Files.ps1 `
    -SourcePath '/Users/example/Designs/icons' `
    -DesktopPath '/Users/example/Desktop' `
    -ListPath './文件列表_试跑3个.txt'

.EXAMPLE
.\Affinity_Stage_Source_Files.ps1 `
    -SourcePath 'C:\Users\example\Designs\icons' `
    -DesktopPath 'C:\Users\example\Desktop'
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ListPath = '',

    [Parameter(Mandatory, Position = 1)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,

    [Parameter(Mandatory, Position = 2)]
    [Alias('DestinationRoot')]
    [ValidateNotNullOrEmpty()]
    [string]$DesktopPath
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-CodePoints {
    param([int[]]$Values)
    return -join ($Values | ForEach-Object { [char]$_ })
}

function Get-SafeFileStem {
    param([string]$Value)
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $result = $Value
    foreach ($character in $invalid) {
        $result = $result.Replace([string]$character, '_')
    }
    $result = $result.Trim().TrimEnd('.', ' ')
    if ([string]::IsNullOrWhiteSpace($result)) {
        return 'List'
    }
    return $result
}

function Test-PortableAbsolutePath {
    param([string]$Value)

    $normalized = $Value.Replace('\', '/')
    return (
        $normalized.StartsWith('/') -or
        $normalized -match '^[A-Za-z]:/'
    )
}

function Get-PortableFileName {
    param([string]$Value)

    $normalized = $Value.Replace('\', '/').TrimEnd('/')
    $lastSeparator = $normalized.LastIndexOf('/')
    if ($lastSeparator -ge 0) {
        return $normalized.Substring($lastSeparator + 1)
    }
    return $normalized
}

function ConvertTo-NativeRelativePath {
    param([string]$Value)

    $normalized = $Value.Replace('\', '/').Trim()
    while ($normalized.StartsWith('./')) {
        $normalized = $normalized.Substring(2)
    }

    $segments = @($normalized.Split('/') | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and $_ -ne '.'
    })
    if ($segments.Count -eq 0) {
        throw "Invalid empty source entry: $Value"
    }
    if ($segments -contains '..') {
        throw "Parent-directory traversal is not allowed in a source entry: $Value"
    }

    $result = $segments[0]
    for ($index = 1; $index -lt $segments.Count; $index++) {
        $result = Join-Path $result $segments[$index]
    }
    return $result
}

try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $utf8NoBom

    $defaultListName = (ConvertFrom-CodePoints @(0x6587, 0x4EF6, 0x5217, 0x8868)) + '.txt'
    $workingFolderName = 'Affinity ' + (ConvertFrom-CodePoints @(0x6279, 0x91CF, 0x5BFC, 0x51FA))
    $maxFilesPerList = 150

    $sourceRoot = [System.IO.Path]::GetFullPath($SourcePath)
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Source folder not found: $sourceRoot"
    }

    $desktopFolder = [System.IO.Path]::GetFullPath($DesktopPath)
    if (-not (Test-Path -LiteralPath $desktopFolder -PathType Container)) {
        throw "Desktop folder not found: $desktopFolder"
    }

    if ([string]::IsNullOrWhiteSpace($ListPath)) {
        $ListPath = Join-Path $sourceRoot $defaultListName
    }

    $listFullPath = [System.IO.Path]::GetFullPath($ListPath)
    if (-not (Test-Path -LiteralPath $listFullPath -PathType Leaf)) {
        throw "List file not found: $listFullPath"
    }

    $rawLines = [System.IO.File]::ReadAllLines($listFullPath, $utf8NoBom)
    $sourcePaths = [System.Collections.Generic.List[string]]::new()

    foreach ($rawLine in $rawLines) {
        $line = $rawLine.Trim().TrimStart([char]0xFEFF)
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        if (Test-PortableAbsolutePath $line) {
            $portableFileName = Get-PortableFileName $line
            if ([string]::IsNullOrWhiteSpace($portableFileName)) {
                throw "Invalid source entry: $line"
            }
            $sourceFilePath = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $portableFileName))
        }
        else {
            $relativePath = ConvertTo-NativeRelativePath $line
            $sourceFilePath = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $relativePath))
        }

        if ([System.IO.Path]::GetExtension($sourceFilePath) -ine '.afdesign') {
            throw "Unsupported input (expected .afdesign): $sourceFilePath"
        }
        if (-not (Test-Path -LiteralPath $sourceFilePath -PathType Leaf)) {
            throw (
                "Source file not found: $sourceFilePath" +
                " (list entry: $line; source root: $sourceRoot)"
            )
        }

        $sourcePaths.Add($sourceFilePath)
    }

    if ($sourcePaths.Count -eq 0) {
        throw "The selected list is empty: $listFullPath"
    }

    $listStem = Get-SafeFileStem ([System.IO.Path]::GetFileNameWithoutExtension($listFullPath))
    $workingFolder = Join-Path $desktopFolder $workingFolderName
    $stagingFolder = Join-Path $workingFolder ('Source_' + $listStem)
    $stagedListPrefix = 'Staged_List_' + $listStem

    [System.IO.Directory]::CreateDirectory($stagingFolder) | Out-Null

    $seenNames = @{}
    $stagedPaths = [System.Collections.Generic.List[string]]::new()

    for ($index = 0; $index -lt $sourcePaths.Count; $index++) {
        $sourceFilePath = $sourcePaths[$index]
        $fileName = [System.IO.Path]::GetFileName($sourceFilePath)
        $nameKey = $fileName.ToLowerInvariant()

        if ($seenNames.ContainsKey($nameKey) -and $seenNames[$nameKey] -ine $sourceFilePath) {
            throw "Two different source files have the same filename: $fileName"
        }
        $seenNames[$nameKey] = $sourceFilePath

        $destinationPath = Join-Path $stagingFolder $fileName
        $percent = [math]::Floor((($index + 1) / $sourcePaths.Count) * 100)
        Write-Progress -Activity 'Staging Affinity source files' -Status $fileName -PercentComplete $percent
        Copy-Item -LiteralPath $sourceFilePath -Destination $destinationPath -Force
        $stagedPaths.Add([System.IO.Path]::GetFullPath($destinationPath))
    }

    Write-Progress -Activity 'Staging Affinity source files' -Completed

    $listCount = [int][math]::Ceiling($stagedPaths.Count / [double]$maxFilesPerList)
    $generatedListPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $generatedListInfo = [System.Collections.Generic.List[object]]::new()

    for ($listIndex = 0; $listIndex -lt $listCount; $listIndex++) {
        $sequence = '{0:D3}' -f ($listIndex + 1)
        $stagedListPath = Join-Path $workingFolder ($stagedListPrefix + '_' + $sequence + '.txt')
        $startIndex = $listIndex * $maxFilesPerList
        $endIndex = [math]::Min($startIndex + $maxFilesPerList, $stagedPaths.Count)
        $chunkPaths = [System.Collections.Generic.List[string]]::new()

        for ($pathIndex = $startIndex; $pathIndex -lt $endIndex; $pathIndex++) {
            $chunkPaths.Add($stagedPaths[$pathIndex])
        }

        [System.IO.File]::WriteAllLines($stagedListPath, $chunkPaths, $utf8NoBom)
        $stagedListFullPath = [System.IO.Path]::GetFullPath($stagedListPath)
        $generatedListPaths.Add($stagedListFullPath) | Out-Null
        $generatedListInfo.Add([PSCustomObject]@{
            Sequence = $sequence
            Count = $chunkPaths.Count
            Path = $stagedListFullPath
        })
    }

    # Remove only list files generated by older versions/runs for this same
    # input-list stem. This prevents accidentally selecting a stale unnumbered
    # 349-file list after the new numbered chunks have been created.
    $legacyListName = $stagedListPrefix + '.txt'
    $numberedListPattern = '^' + [regex]::Escape($stagedListPrefix) + '_\d+\.txt$'
    foreach ($candidate in (Get-ChildItem -LiteralPath $workingFolder -File)) {
        $isGeneratedListName =
            $candidate.Name -ieq $legacyListName -or
            $candidate.Name -match $numberedListPattern

        if ($isGeneratedListName -and -not $generatedListPaths.Contains($candidate.FullName)) {
            Remove-Item -LiteralPath $candidate.FullName -Force
        }
    }

    Write-Host ''
    Write-Host 'STAGING_COMPLETE' -ForegroundColor Green
    Write-Host ("Files: {0}" -f $stagedPaths.Count)
    Write-Host ("List files: {0}; maximum files per list: {1}" -f $listCount, $maxFilesPerList)
    Write-Host ("Source root: {0}" -f $sourceRoot)
    Write-Host ("Desktop root: {0}" -f $desktopFolder)
    Write-Host ("Staged folder: {0}" -f $stagingFolder)
    Write-Host 'Affinity lists (run in this order):'
    foreach ($listInfo in $generatedListInfo) {
        Write-Host ("  [{0}] {1} files: {2}" -f $listInfo.Sequence, $listInfo.Count, $listInfo.Path)
    }
    Write-Host ''
    Write-Host 'Next: run one numbered list, manually close all opened documents without saving, then run the next list.'
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'STAGING_FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
