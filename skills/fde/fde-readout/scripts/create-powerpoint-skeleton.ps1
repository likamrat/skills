[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Plan,

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [string]$Seed,

    [string[]]$SmokeSlideIds
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-NotesBody {
    param(
        [Parameter(Mandatory = $true)]
        $Slide
    )

    $shapes = $Slide.NotesPage.Shapes
    for ($index = 1; $index -le $shapes.Count; $index++) {
        $shape = $shapes.Item($index)
        if ($shape.Type -eq 14 -and $shape.PlaceholderFormat.Type -eq 2) {
            return $shape
        }
    }

    throw "Slide $($Slide.SlideIndex) has no notes-body placeholder."
}

function Get-NotesText {
    param(
        [Parameter(Mandatory = $true)]
        $PlanSlide
    )

    $evidence = @($PlanSlide.evidenceIds) -join ', '
    $judgment = @($PlanSlide.judgmentIds) -join ', '
    return @(
        [string]$PlanSlide.notes
        "Evidence: $evidence"
        "Human context: $judgment"
    ) -join "`r`n"
}

function Get-PackageFacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
        $slideParts = @($entryNames | Where-Object { $_ -match '^ppt/slides/slide\d+\.xml$' })
        $notesParts = @($entryNames | Where-Object { $_ -match '^ppt/notesSlides/notesSlide\d+\.xml$' })
        $notesTargets = @()

        foreach ($entry in @($archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/_rels/slide\d+\.xml\.rels$' })) {
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try {
                [xml]$relationships = $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }

            foreach ($relationship in @($relationships.Relationships.Relationship)) {
                if ([string]$relationship.Type -match '/notesSlide$') {
                    $notesTargets += [string]$relationship.Target
                }
            }
        }

        $macroEntries = @($entryNames | Where-Object { $_ -match '(?i)(?:^|/)vbaProject\.bin$' })
        $contentTypesEntry = $archive.GetEntry('[Content_Types].xml')
        if ($null -eq $contentTypesEntry) {
            throw 'PowerPoint package omits [Content_Types].xml.'
        }
        $reader = New-Object System.IO.StreamReader($contentTypesEntry.Open())
        try {
            $contentTypes = $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }

        [pscustomobject]@{
            slideParts = $slideParts.Count
            notesParts = $notesParts.Count
            notesRelationships = $notesTargets.Count
            uniqueNotesRelationships = @($notesTargets | Sort-Object -Unique).Count
            macroFree = $macroEntries.Count -eq 0 -and $contentTypes -notmatch 'macroEnabled'
        }
    }
    finally {
        $archive.Dispose()
    }
}

$powerPoint = $null
$presentation = $null
$reopened = $null
$result = $null
$operationErrorMessage = $null
$cleanupErrorMessage = $null
$powerPointProcessId = 0
$powerPointProcessStart = $null
$ownsPowerPointProcess = $false
$powerPointCleanupMode = $null
$powerPointGraceSeconds = 5
$powerPointMutex = $null
$powerPointMutexHeld = $false

try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class FdePowerPointNativeMethods
{
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

    $seedInput = if ([string]::IsNullOrWhiteSpace($Seed)) {
        Join-Path $PSScriptRoot '..\assets\powerpoint-16x9-seed.pptx'
    }
    else {
        $Seed
    }

    $planPath = (Resolve-Path -LiteralPath $Plan).Path
    $seedPath = (Resolve-Path -LiteralPath $seedInput).Path
    $outputPath = [System.IO.Path]::GetFullPath($Output)
    $outputDirectory = Split-Path -Parent $outputPath

    if (-not (Test-Path -LiteralPath $outputDirectory)) {
        [void](New-Item -ItemType Directory -Path $outputDirectory)
    }

    $readout = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json
    $planSlides = @($readout.slides)
    if ($planSlides.Count -lt 1) {
        throw 'ReadoutPlan must contain at least one slide.'
    }

    $sourcePlanSha256 = Get-Sha256 -Path $planPath
    $selectedSlides = $planSlides
    $selectionMode = 'full'

    if ($PSBoundParameters.ContainsKey('SmokeSlideIds')) {
        $requestedIds = @($SmokeSlideIds)
        if ($requestedIds.Count -eq 1 -and $requestedIds[0].Contains(',')) {
            $requestedIds = @($requestedIds[0].Split(','))
        }
        if ($requestedIds.Count -ne 3) {
            throw 'SmokeSlideIds must contain exactly 3 slide IDs.'
        }

        $requestedIdSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($slideId in $requestedIds) {
            if ([string]::IsNullOrWhiteSpace($slideId)) {
                throw 'SmokeSlideIds cannot contain an empty slide ID.'
            }
            if (-not $requestedIdSet.Add($slideId)) {
                throw "SmokeSlideIds must contain 3 unique slide IDs; duplicate ID: $slideId."
            }
        }

        if (-not $requestedIdSet.Contains([string]$planSlides[0].id)) {
            throw "SmokeSlideIds must include the full plan's first cover slide ID: $($planSlides[0].id)."
        }
        if ($planSlides.Count -lt 2 -or -not $requestedIdSet.Contains([string]$planSlides[1].id)) {
            $decisionId = if ($planSlides.Count -ge 2) { [string]$planSlides[1].id } else { '<missing>' }
            throw "SmokeSlideIds must include the full plan's second decision slide ID: $decisionId."
        }

        $planIdSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($planSlide in $planSlides) {
            [void]$planIdSet.Add([string]$planSlide.id)
        }
        foreach ($slideId in $requestedIds) {
            if (-not $planIdSet.Contains($slideId)) {
                throw "SmokeSlideIds contains an ID that does not exist in the full plan: $slideId."
            }
        }

        $selectedSlides = @($planSlides | Where-Object { $requestedIdSet.Contains([string]$_.id) })
        if ($selectedSlides.Count -ne 3) {
            throw 'SmokeSlideIds did not resolve to exactly 3 slides in the full plan.'
        }
        $selectionMode = 'smoke'
    }

    $powerPointMutex = [Threading.Mutex]::new(
        $false,
        'Local\FdeReadoutPowerPointSkeleton'
    )
    try {
        $powerPointMutexHeld = $powerPointMutex.WaitOne([TimeSpan]::FromSeconds(30))
    }
    catch [Threading.AbandonedMutexException] {
        $powerPointMutexHeld = $true
    }
    if (-not $powerPointMutexHeld) {
        throw 'Timed out waiting for exclusive PowerPoint automation access.'
    }

    Copy-Item -LiteralPath $seedPath -Destination $outputPath -Force

    $baselinePowerPointIds = @(
        Get-Process -Name POWERPNT -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Id }
    )

    $powerPoint = New-Object -ComObject PowerPoint.Application
    $windowHandle = [IntPtr][int64]$powerPoint.HWND
    if ($windowHandle -eq [IntPtr]::Zero) {
        throw 'PowerPoint automation returned an invalid window handle.'
    }

    [uint32]$resolvedProcessId = 0
    [void][FdePowerPointNativeMethods]::GetWindowThreadProcessId(
        $windowHandle,
        [ref]$resolvedProcessId
    )
    if ($resolvedProcessId -le 0) {
        throw 'PowerPoint automation returned an invalid process ID.'
    }
    if ($baselinePowerPointIds -contains [int]$resolvedProcessId) {
        throw "PowerPoint automation attached to a pre-existing process (PID $resolvedProcessId)."
    }

    $resolvedProcess = Get-Process -Id ([int]$resolvedProcessId) -ErrorAction Stop
    if ($resolvedProcess.ProcessName -ne 'POWERPNT') {
        throw "PowerPoint window resolved to unexpected process $($resolvedProcess.ProcessName) (PID $resolvedProcessId)."
    }
    $powerPointProcessId = [int]$resolvedProcessId
    $powerPointProcessStart = $resolvedProcess.StartTime
    $ownsPowerPointProcess = $true

    $presentation = $powerPoint.Presentations.Open(
        $outputPath,
        $false,
        $false,
        $false
    )

    if ($presentation.Slides.Count -ne 1) {
        throw "Expected one seed slide, found $($presentation.Slides.Count)."
    }
    if ($presentation.SlideMaster.CustomLayouts.Count -lt 7) {
        throw 'The clean seed does not contain the required blank layout.'
    }

    $blankLayout = $presentation.SlideMaster.CustomLayouts.Item(7)
    for ($index = 0; $index -lt $selectedSlides.Count; $index++) {
        $slideNumber = $index + 1
        $slide = if ($slideNumber -eq 1) {
            $presentation.Slides.Item(1)
        }
        else {
            $presentation.Slides.AddSlide($slideNumber, $blankLayout)
        }

        $notesBody = Get-NotesBody -Slide $slide
        $notesBody.TextFrame.TextRange.Text = Get-NotesText -PlanSlide $selectedSlides[$index]
    }

    $presentation.Save()
    $presentation.Close()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation)
    $presentation = $null

    $reopened = $powerPoint.Presentations.Open(
        $outputPath,
        $true,
        $false,
        $false
    )

    if ($reopened.Slides.Count -ne $selectedSlides.Count) {
        throw "Expected $($selectedSlides.Count) slides, found $($reopened.Slides.Count)."
    }
    if ($reopened.PageSetup.SlideWidth -ne 960 -or $reopened.PageSetup.SlideHeight -ne 540) {
        throw "Expected a 960x540 point 16:9 deck, found $($reopened.PageSetup.SlideWidth)x$($reopened.PageSetup.SlideHeight)."
    }

    $verifiedNotes = 0
    for ($index = 0; $index -lt $selectedSlides.Count; $index++) {
        $slide = $reopened.Slides.Item($index + 1)
        $notesText = (Get-NotesBody -Slide $slide).TextFrame.TextRange.Text
        $expectedEvidence = @($selectedSlides[$index].evidenceIds)
        $expectedJudgment = @($selectedSlides[$index].judgmentIds)

        if ([string]::IsNullOrWhiteSpace($notesText) -or -not $notesText.Contains('Evidence:')) {
            throw "Slide $($index + 1) notes were not populated."
        }
        foreach ($evidenceId in $expectedEvidence) {
            if (-not $notesText.Contains([string]$evidenceId)) {
                throw "Slide $($index + 1) notes omit evidence ID $evidenceId."
            }
        }
        foreach ($judgmentId in $expectedJudgment) {
            if (-not $notesText.Contains([string]$judgmentId)) {
                throw "Slide $($index + 1) notes omit human-context ID $judgmentId."
            }
        }
        $verifiedNotes++
    }

    $slideCount = $reopened.Slides.Count
    $widthPoints = $reopened.PageSetup.SlideWidth
    $heightPoints = $reopened.PageSetup.SlideHeight
    $reopened.Close()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($reopened)
    $reopened = $null

    $packageFacts = Get-PackageFacts -Path $outputPath
    if ($packageFacts.slideParts -ne $selectedSlides.Count) {
        throw "Expected $($selectedSlides.Count) package slide parts, found $($packageFacts.slideParts)."
    }
    if ($packageFacts.notesParts -ne $selectedSlides.Count) {
        throw "Expected $($selectedSlides.Count) package notes parts, found $($packageFacts.notesParts)."
    }
    if ($packageFacts.notesRelationships -ne $selectedSlides.Count -or $packageFacts.uniqueNotesRelationships -ne $selectedSlides.Count) {
        throw "Expected $($selectedSlides.Count) unique slide-to-notes relationships, found $($packageFacts.uniqueNotesRelationships)."
    }
    if (-not $packageFacts.macroFree) {
        throw 'Expected a macro-free PowerPoint package.'
    }

    $result = [pscustomobject]@{
        output = $outputPath
        slides = $slideCount
        verifiedNotes = $verifiedNotes
        widthPoints = $widthPoints
        heightPoints = $heightPoints
        selectionMode = $selectionMode
        sourcePlanSha256 = $sourcePlanSha256
        selectedSlideIds = @($selectedSlides | ForEach-Object { [string]$_.id })
        selectedSlideFamilies = @($selectedSlides | ForEach-Object { [string]$_.family })
        packageSlides = $packageFacts.slideParts
        packageNotesParts = $packageFacts.notesParts
        uniqueNotesRelationships = $packageFacts.uniqueNotesRelationships
        macroFree = $packageFacts.macroFree
        sha256 = Get-Sha256 -Path $outputPath
    }
}
catch {
    $operationErrorMessage = $_.Exception.Message
}
finally {
    if ($null -ne $reopened) {
        try { $reopened.Close() } catch {}
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($reopened)
        }
        catch {
            if ($null -eq $operationErrorMessage) {
                $operationErrorMessage = $_.Exception.Message
            }
        }
        $reopened = $null
    }
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch {}
        try {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation)
        }
        catch {
            if ($null -eq $operationErrorMessage) {
                $operationErrorMessage = $_.Exception.Message
            }
        }
        $presentation = $null
    }
    if ($null -ne $powerPoint) {
        if ($ownsPowerPointProcess) {
            try { $powerPoint.Quit() } catch {}
        }
        $powerPoint = $null
    }

    if ($ownsPowerPointProcess) {
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds($powerPointGraceSeconds)
            $remainingProcess = Get-Process -Id $powerPointProcessId -ErrorAction SilentlyContinue
            while (
                $null -ne $remainingProcess -and
                [DateTimeOffset]::UtcNow -lt $deadline
            ) {
                Start-Sleep -Milliseconds 100
                $remainingProcess = Get-Process -Id $powerPointProcessId -ErrorAction SilentlyContinue
            }

            if ($null -eq $remainingProcess) {
                $powerPointCleanupMode = 'graceful'
            }
            else {
                if ($remainingProcess.StartTime -ne $powerPointProcessStart) {
                    $cleanupErrorMessage = "PowerPoint process identity changed before cleanup for PID $powerPointProcessId."
                }
                else {
                    try {
                        Stop-Process -Id $powerPointProcessId -Force -ErrorAction Stop
                    }
                    catch {
                        if (-not $remainingProcess.HasExited) {
                            throw
                        }
                    }

                    if (-not $remainingProcess.WaitForExit(5000)) {
                        $cleanupErrorMessage = "PowerPoint process PID $powerPointProcessId survived forced termination."
                    }
                    else {
                        $powerPointCleanupMode = 'forced'
                    }
                }
            }
        }
        catch {
            $cleanupErrorMessage = "Could not terminate PowerPoint process PID ${powerPointProcessId}: $($_.Exception.Message)"
        }
    }

    if ($powerPointMutexHeld) {
        try {
            $powerPointMutex.ReleaseMutex()
        }
        catch {
            if ($null -eq $operationErrorMessage -and $null -eq $cleanupErrorMessage) {
                $operationErrorMessage = "Could not release the PowerPoint automation mutex: $($_.Exception.Message)"
            }
        }
        $powerPointMutexHeld = $false
    }
    if ($null -ne $powerPointMutex) {
        try {
            $powerPointMutex.Dispose()
        }
        catch {
            if ($null -eq $operationErrorMessage -and $null -eq $cleanupErrorMessage) {
                $operationErrorMessage = "Could not dispose the PowerPoint automation mutex: $($_.Exception.Message)"
            }
        }
        $powerPointMutex = $null
    }
}

if ($null -ne $cleanupErrorMessage) {
    $message = if ($null -ne $operationErrorMessage) {
        "$operationErrorMessage Cleanup failed: $cleanupErrorMessage"
    }
    else {
        "PowerPoint cleanup failed: $cleanupErrorMessage"
    }
    [Console]::Error.WriteLine($message)
    [Console]::Error.Flush()
    [Environment]::Exit(1)
}

if ($null -ne $operationErrorMessage) {
    $cleanupSummary = if ($ownsPowerPointProcess -and $null -ne $powerPointCleanupMode) {
        " PowerPoint cleanup: PID $powerPointProcessId exited via $powerPointCleanupMode."
    }
    else {
        ''
    }
    [Console]::Error.WriteLine("PowerPoint skeleton creation failed: $operationErrorMessage$cleanupSummary")
    [Console]::Error.Flush()
    [Environment]::Exit(1)
}

[void]$result.PSObject.Properties.Add(
    [Management.Automation.PSNoteProperty]::new(
        'powerPointCleanup',
        [pscustomobject]@{
            ownedProcessId = $powerPointProcessId
            exited = $true
            mode = $powerPointCleanupMode
            graceSeconds = $powerPointGraceSeconds
        }
    )
)
$resultJson = $result | ConvertTo-Json -Depth 4
[Console]::Out.WriteLine($resultJson)
[Console]::Out.Flush()
[Environment]::Exit(0)
