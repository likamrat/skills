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

Copy-Item -LiteralPath $seedPath -Destination $outputPath -Force

$powerPoint = $null
$presentation = $null
$reopened = $null

try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
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

    [pscustomobject]@{
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
    } | ConvertTo-Json -Depth 4
}
finally {
    if ($null -ne $reopened) {
        try { $reopened.Close() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($reopened)
    }
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation)
    }
    if ($null -ne $powerPoint) {
        try { $powerPoint.Quit() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
