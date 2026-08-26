[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Plan,

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [string]$Seed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
    for ($index = 0; $index -lt $planSlides.Count; $index++) {
        $slideNumber = $index + 1
        $slide = if ($slideNumber -eq 1) {
            $presentation.Slides.Item(1)
        }
        else {
            $presentation.Slides.AddSlide($slideNumber, $blankLayout)
        }

        $notesBody = Get-NotesBody -Slide $slide
        $notesBody.TextFrame.TextRange.Text = Get-NotesText -PlanSlide $planSlides[$index]
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

    if ($reopened.Slides.Count -ne $planSlides.Count) {
        throw "Expected $($planSlides.Count) slides, found $($reopened.Slides.Count)."
    }
    if ($reopened.PageSetup.SlideWidth -ne 960 -or $reopened.PageSetup.SlideHeight -ne 540) {
        throw "Expected a 960x540 point 16:9 deck, found $($reopened.PageSetup.SlideWidth)x$($reopened.PageSetup.SlideHeight)."
    }

    $verifiedNotes = 0
    for ($index = 0; $index -lt $planSlides.Count; $index++) {
        $slide = $reopened.Slides.Item($index + 1)
        $notesText = (Get-NotesBody -Slide $slide).TextFrame.TextRange.Text
        $expectedEvidence = @($planSlides[$index].evidenceIds)

        if ([string]::IsNullOrWhiteSpace($notesText) -or -not $notesText.Contains('Evidence:')) {
            throw "Slide $($index + 1) notes were not populated."
        }
        foreach ($evidenceId in $expectedEvidence) {
            if (-not $notesText.Contains([string]$evidenceId)) {
                throw "Slide $($index + 1) notes omit evidence ID $evidenceId."
            }
        }
        $verifiedNotes++
    }

    [pscustomobject]@{
        output = $outputPath
        slides = $reopened.Slides.Count
        verifiedNotes = $verifiedNotes
        widthPoints = $reopened.PageSetup.SlideWidth
        heightPoints = $reopened.PageSetup.SlideHeight
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
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
