[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Spec,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedSpecSha256,

    [Parameter(Mandatory = $true)]
    [string]$Skeleton,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [ValidateSet(
        'notes',
        'delete',
        'text',
        'shape',
        'line',
        'table',
        'connector',
        'activation',
        'hwnd',
        'process-acquired',
        'process-validated',
        'overflow',
        'save',
        'reopen',
        'export',
        'publish-bundle'
    )]
    [string]$FailAfter
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module `
    -Name (Join-Path $PSScriptRoot 'powerpoint-workflow-connectors.psm1') `
    -Force

Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class FdePowerPointWorkerNativeMethods
{
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags
    );

    public static string GetFinalPath(string path)
    {
        const uint shareReadWriteDelete = 0x00000001 | 0x00000002 | 0x00000004;
        const uint openExisting = 3;
        const uint backupSemantics = 0x02000000;
        using (SafeFileHandle handle = CreateFile(
            path,
            0,
            shareReadWriteDelete,
            IntPtr.Zero,
            openExisting,
            backupSemantics,
            IntPtr.Zero
        ))
        {
            if (handle.IsInvalid)
            {
                throw new IOException(
                    "Could not open path for canonicalization.",
                    Marshal.GetLastWin32Error()
                );
            }
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(
                handle,
                buffer,
                (uint)buffer.Capacity,
                0
            );
            if (length == 0 || length >= buffer.Capacity)
            {
                throw new IOException(
                    "Could not resolve canonical path.",
                    Marshal.GetLastWin32Error()
                );
            }
            string result = buffer.ToString();
            if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            {
                return @"\\" + result.Substring(8);
            }
            if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
            {
                return result.Substring(4);
            }
            return result;
        }
    }
}
'@

$script:cleanupErrors = [System.Collections.Generic.List[string]]::new()

function Release-ComRef {
    param(
        [Parameter(Mandatory = $true)]
        [ref]$Reference,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($null -eq $Reference.Value) {
        return
    }

    try {
        if ([Runtime.InteropServices.Marshal]::IsComObject($Reference.Value)) {
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Reference.Value)
        }
    }
    catch {
        $script:cleanupErrors.Add("${Label}: $($_.Exception.Message)")
    }
    finally {
        $Reference.Value = $null
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-BytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Normalize-NotesText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $missingSegments = [System.Collections.Generic.Stack[string]]::new()
    $existingPath = $fullPath
    while (-not (Test-Path -LiteralPath $existingPath)) {
        $leaf = [IO.Path]::GetFileName($existingPath)
        if ([string]::IsNullOrWhiteSpace($leaf)) {
            throw "Path has no existing canonical ancestor: $fullPath."
        }
        $missingSegments.Push($leaf)
        $parent = [IO.Path]::GetDirectoryName($existingPath)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $existingPath) {
            throw "Path has no existing canonical ancestor: $fullPath."
        }
        $existingPath = $parent
    }

    $canonical = [FdePowerPointWorkerNativeMethods]::GetFinalPath($existingPath)
    while ($missingSegments.Count -gt 0) {
        $canonical = Join-Path $canonical $missingSegments.Pop()
    }
    return [IO.Path]::GetFullPath($canonical).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-PathSameOrAncestor {
    param(
        [Parameter(Mandatory = $true)][string]$First,
        [Parameter(Mandatory = $true)][string]$Second
    )

    if ([string]::Equals($First, $Second, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = $First.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return $Second.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-IndependentPaths {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Paths)

    $entries = @($Paths.GetEnumerator())
    for ($left = 0; $left -lt $entries.Count; $left++) {
        for ($right = $left + 1; $right -lt $entries.Count; $right++) {
            $leftPath = [string]$entries[$left].Value
            $rightPath = [string]$entries[$right].Value
            if (
                (Test-PathSameOrAncestor -First $leftPath -Second $rightPath) -or
                (Test-PathSameOrAncestor -First $rightPath -Second $leftPath)
            ) {
                throw "Paths must not alias or contain one another: $($entries[$left].Key) and $($entries[$right].Key)."
            }
        }
    }
}

function Convert-HexColor {
    param([Parameter(Mandatory = $true)][string]$Hex)

    $value = $Hex.TrimStart('#')
    if ($value -notmatch '^[0-9a-fA-F]{6}$') {
        throw "Invalid six-digit color: $Hex."
    }
    $red = [Convert]::ToInt32($value.Substring(0, 2), 16)
    $green = [Convert]::ToInt32($value.Substring(2, 2), 16)
    $blue = [Convert]::ToInt32($value.Substring(4, 2), 16)
    return $red + ($green -shl 8) + ($blue -shl 16)
}

function Get-RoleColor {
    param(
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][string]$Role
    )

    $property = $Theme.colors.PSObject.Properties[$Role]
    if ($null -eq $property) {
        throw "Unknown theme color role: $Role."
    }
    return Convert-HexColor -Hex ([string]$property.Value)
}

function Set-SlideBackground {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][string]$Role
    )

    $background = $null
    $fill = $null
    $color = $null
    try {
        $Slide.FollowMasterBackground = 0
        $background = $Slide.Background
        $fill = $background.Fill
        $fill.Solid()
        $color = $fill.ForeColor
        $color.RGB = Get-RoleColor -Theme $Theme -Role $Role
        $fill.Transparency = 0
    }
    finally {
        Release-ComRef -Reference ([ref]$color) -Label 'slide background color'
        Release-ComRef -Reference ([ref]$fill) -Label 'slide background fill'
        Release-ComRef -Reference ([ref]$background) -Label 'slide background'
    }
}

function Assert-SlideBackground {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    $background = $null
    $fill = $null
    $color = $null
    try {
        if ([int]$Slide.FollowMasterBackground -ne 0) {
            throw "Slide $SlideIndex still follows the master background."
        }
        $background = $Slide.Background
        $fill = $background.Fill
        $color = $fill.ForeColor
        $expected = Get-RoleColor -Theme $Theme -Role $Role
        if ([int]$color.RGB -ne $expected) {
            throw "Slide $SlideIndex background color does not match role '$Role'."
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$color) -Label 'reopened slide background color'
        Release-ComRef -Reference ([ref]$fill) -Label 'reopened slide background fill'
        Release-ComRef -Reference ([ref]$background) -Label 'reopened slide background'
    }
}

function Get-DashStyle {
    param([Parameter(Mandatory = $true)][string]$Dash)

    switch ($Dash) {
        'solid' { return 1 }
        'dot' { return 3 }
        'dash' { return 4 }
        'dashDot' { return 5 }
        default { throw "Unsupported line dash: $Dash." }
    }
}

function Get-ShapeType {
    param([Parameter(Mandatory = $true)][string]$ShapeType)

    switch ($ShapeType) {
        'rect' { return 1 }
        'roundRect' { return 5 }
        'ellipse' { return 9 }
        'diamond' { return 4 }
        default { throw "Unsupported shape type: $ShapeType." }
    }
}

function Get-HorizontalAlignment {
    param([Parameter(Mandatory = $true)][string]$Alignment)

    switch ($Alignment) {
        'left' { return 1 }
        'center' { return 2 }
        'right' { return 3 }
        default { throw "Unsupported horizontal alignment: $Alignment." }
    }
}

function Get-VerticalAlignment {
    param([Parameter(Mandatory = $true)][string]$Alignment)

    switch ($Alignment) {
        'top' { return 1 }
        'middle' { return 3 }
        'bottom' { return 4 }
        default { throw "Unsupported vertical alignment: $Alignment." }
    }
}

function Invoke-TestFailpoint {
    param([Parameter(Mandatory = $true)][string]$Stage)

    if ($FailAfter -ne $Stage) {
        return
    }
    if ($env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1') {
        throw 'PowerPoint worker failpoints require FDE_POWERPOINT_TEST_FAILPOINTS=1.'
    }
    throw "Test failpoint after $Stage."
}

function Add-TextPrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shape = $null
    $shapeLine = $null
    $shapeFill = $null
    $legacyFrame = $null
    $frame2 = $null
    $range2 = $null
    $font2 = $null
    $fontFill = $null
    $fontColor = $null
    $paragraph = $null
    try {
        $shape = $Shapes.AddTextbox(
            1,
            [single]$Primitive.x,
            [single]$Primitive.y,
            [single]$Primitive.w,
            [single]$Primitive.h
        )
        $shape.Name = [string]$Primitive.name
        $shape.Rotation = [single]$Primitive.rotation

        $shapeLine = $shape.Line
        $shapeLine.Visible = 0
        $shapeFill = $shape.Fill
        $shapeFill.Visible = 0

        $legacyFrame = $shape.TextFrame
        $legacyFrame.AutoSize = 0
        $legacyFrame.WordWrap = -1

        $frame2 = $shape.TextFrame2
        $frame2.MarginLeft = [single]$Primitive.marginLeft
        $frame2.MarginRight = [single]$Primitive.marginRight
        $frame2.MarginTop = [single]$Primitive.marginTop
        $frame2.MarginBottom = [single]$Primitive.marginBottom
        $frame2.WordWrap = if ($Primitive.wordWrap) { -1 } else { 0 }
        $frame2.AutoSize = 0
        $frame2.VerticalAnchor = Get-VerticalAlignment -Alignment ([string]$Primitive.verticalAlign)

        $range2 = $frame2.TextRange
        $range2.Text = [string]$Primitive.text
        $font2 = $range2.Font
        $font2.Name = [string]$Theme.fontFamily
        $font2.Size = [single]$Primitive.fontSize
        $font2.Bold = if ($Primitive.bold) { -1 } else { 0 }
        $font2.Italic = if ($Primitive.italic) { -1 } else { 0 }
        $fontFill = $font2.Fill
        $fontColor = $fontFill.ForeColor
        $fontColor.RGB = Get-RoleColor -Theme $Theme -Role ([string]$Primitive.colorRole)
        $paragraph = $range2.ParagraphFormat
        $paragraph.Alignment = Get-HorizontalAlignment -Alignment ([string]$Primitive.horizontalAlign)
    }
    finally {
        Release-ComRef -Reference ([ref]$paragraph) -Label 'text paragraph format'
        Release-ComRef -Reference ([ref]$fontColor) -Label 'text font color'
        Release-ComRef -Reference ([ref]$fontFill) -Label 'text font fill'
        Release-ComRef -Reference ([ref]$font2) -Label 'text font'
        Release-ComRef -Reference ([ref]$range2) -Label 'text range'
        Release-ComRef -Reference ([ref]$frame2) -Label 'text frame 2'
        Release-ComRef -Reference ([ref]$legacyFrame) -Label 'legacy text frame'
        Release-ComRef -Reference ([ref]$shapeFill) -Label 'text shape fill'
        Release-ComRef -Reference ([ref]$shapeLine) -Label 'text shape line'
        Release-ComRef -Reference ([ref]$shape) -Label 'text shape'
    }
}

function Add-ShapePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shape = $null
    $fill = $null
    $fillColor = $null
    $line = $null
    $lineColor = $null
    try {
        $shape = $Shapes.AddShape(
            (Get-ShapeType -ShapeType ([string]$Primitive.shapeType)),
            [single]$Primitive.x,
            [single]$Primitive.y,
            [single]$Primitive.w,
            [single]$Primitive.h
        )
        $shape.Name = [string]$Primitive.name
        $fill = $shape.Fill
        if ($Primitive.fillVisible) {
            $fill.Visible = -1
            $fill.Solid()
            $fillColor = $fill.ForeColor
            $fillColor.RGB = Get-RoleColor -Theme $Theme -Role ([string]$Primitive.fillColorRole)
            $fill.Transparency = [single]$Primitive.fillTransparency
        }
        else {
            $fill.Visible = 0
        }

        $line = $shape.Line
        if ($Primitive.lineVisible) {
            $line.Visible = -1
            $lineColor = $line.ForeColor
            $lineColor.RGB = Get-RoleColor -Theme $Theme -Role ([string]$Primitive.lineColorRole)
            $line.Transparency = [single]$Primitive.lineTransparency
            $line.Weight = [single]$Primitive.lineWidth
            $line.DashStyle = Get-DashStyle -Dash ([string]$Primitive.lineDash)
        }
        else {
            $line.Visible = 0
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$lineColor) -Label 'shape line color'
        Release-ComRef -Reference ([ref]$line) -Label 'shape line'
        Release-ComRef -Reference ([ref]$fillColor) -Label 'shape fill color'
        Release-ComRef -Reference ([ref]$fill) -Label 'shape fill'
        Release-ComRef -Reference ([ref]$shape) -Label 'shape'
    }
}

function Add-LinePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shape = $null
    $line = $null
    $lineColor = $null
    try {
        $shape = $Shapes.AddLine(
            [single]$Primitive.x1,
            [single]$Primitive.y1,
            [single]$Primitive.x2,
            [single]$Primitive.y2
        )
        $shape.Name = [string]$Primitive.name
        $line = $shape.Line
        $lineColor = $line.ForeColor
        $lineColor.RGB = Get-RoleColor -Theme $Theme -Role ([string]$Primitive.colorRole)
        $line.Transparency = [single]$Primitive.transparency
        $line.Weight = [single]$Primitive.width
        $line.DashStyle = Get-DashStyle -Dash ([string]$Primitive.dash)
        $line.BeginArrowheadStyle = if ($Primitive.arrowStart -eq 'open') { 3 } else { 1 }
        $line.EndArrowheadStyle = if ($Primitive.arrowEnd -ceq 'open') { 3 } else { 1 }
    }
    finally {
        Release-ComRef -Reference ([ref]$lineColor) -Label 'line color'
        Release-ComRef -Reference ([ref]$line) -Label 'line format'
        Release-ComRef -Reference ([ref]$shape) -Label 'line shape'
    }
}

function Get-FiniteTableNumber {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $numericTypes = @(
        [byte],
        [sbyte],
        [int16],
        [uint16],
        [int32],
        [uint32],
        [int64],
        [uint64],
        [single],
        [double],
        [decimal]
    )
    if ($null -eq $Value -or $Value.GetType() -notin $numericTypes) {
        throw "$Label must be a number."
    }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Label must be finite."
    }
    return $number
}

function Assert-TablePrimitiveSpec {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$SlideSpec,
        [Parameter(Mandatory = $true)]$Theme
    )

    $requiredProperties = @(
        'kind',
        'name',
        'role',
        'z',
        'x',
        'y',
        'w',
        'h',
        'headers',
        'rows',
        'rowEvidenceIds',
        'columnWidths',
        'rowHeights',
        'headerFillColorRole',
        'headerFillTransparency',
        'bodyFillColorRole',
        'alternateFillColorRole',
        'alternateFillTransparency',
        'lineColorRole',
        'lineWidth',
        'headerFontSize',
        'bodyFontSize',
        'headerFontColorRole',
        'bodyFontColorRole',
        'cellMargin'
    )
    $actualProperties = @($Primitive.PSObject.Properties.Name)
    if ($actualProperties.Count -ne $requiredProperties.Count) {
        throw "Table primitive $($Primitive.name) has an unexpected property set."
    }
    for ($propertyIndex = 0; $propertyIndex -lt $requiredProperties.Count; $propertyIndex++) {
        if ($requiredProperties[$propertyIndex] -notin $actualProperties) {
            throw "Table primitive $($Primitive.name) omits $($requiredProperties[$propertyIndex])."
        }
    }

    if (
        $Primitive.kind -isnot [string] -or
        $Primitive.name -isnot [string] -or
        $Primitive.role -isnot [string] -or
        [string]$Primitive.kind -ne 'table' -or
        [string]::IsNullOrWhiteSpace([string]$Primitive.name) -or
        [string]$Primitive.name -notmatch '^fde-[a-z0-9]+(?:-[a-z0-9]+)*$'
    ) {
        throw 'Table primitive identity is invalid.'
    }
    $z = Get-FiniteTableNumber -Value $Primitive.z -Label 'table z'
    if ($z -lt 1 -or $z -ne [math]::Truncate($z)) {
        throw 'Table primitive z must be a positive integer.'
    }

    $x = Get-FiniteTableNumber -Value $Primitive.x -Label 'table x'
    $y = Get-FiniteTableNumber -Value $Primitive.y -Label 'table y'
    $width = Get-FiniteTableNumber -Value $Primitive.w -Label 'table width'
    $height = Get-FiniteTableNumber -Value $Primitive.h -Label 'table height'
    if (
        $x -lt 0 -or
        $y -lt 0 -or
        $width -le 0 -or
        $height -le 0 -or
        $x + $width -gt 960 -or
        $y + $height -gt 478
    ) {
        throw "Table primitive $($Primitive.name) geometry is outside the safe content area."
    }

    foreach ($arrayProperty in @(
        'headers',
        'rows',
        'rowEvidenceIds',
        'columnWidths',
        'rowHeights'
    )) {
        if ($Primitive.$arrayProperty -isnot [Array]) {
            throw "Table $arrayProperty must be an array."
        }
    }
    if ($SlideSpec.evidenceIds -isnot [Array]) {
        throw 'Slide evidenceIds must be an array for native tables.'
    }
    $headers = @($Primitive.headers)
    $rows = @($Primitive.rows)
    $rowEvidenceIds = @($Primitive.rowEvidenceIds)
    $columnWidths = @($Primitive.columnWidths)
    $rowHeights = @($Primitive.rowHeights)
    $family = [string]$SlideSpec.family
    if ($family -eq 'table') {
        if (
            [string]$Primitive.role -ne 'native-table' -or
            $headers.Count -lt 2 -or
            $headers.Count -gt 6 -or
            $rows.Count -lt 1 -or
            $rows.Count -gt 10
        ) {
            throw 'Ordinary native table requires 2-6 columns and 1-10 rows.'
        }
    }
    elseif ($family -eq 'evaluation') {
        $expectedHeaders = @('Cohort', 'Expected behavior', 'Result')
        if (
            [string]$Primitive.role -ne 'native-evaluation-table' -or
            $headers.Count -ne 3 -or
            $rows.Count -lt 3 -or
            $rows.Count -gt 8
        ) {
            throw 'Evaluation native table requires its exact headers and 3-8 rows.'
        }
        for ($headerIndex = 0; $headerIndex -lt $expectedHeaders.Count; $headerIndex++) {
            if (-not [string]::Equals(
                [string]$headers[$headerIndex],
                $expectedHeaders[$headerIndex],
                [StringComparison]::Ordinal
            )) {
                throw 'Evaluation native table headers changed.'
            }
        }
    }
    else {
        throw "Native table $($Primitive.name) is not allowed on a $family slide."
    }

    for ($headerIndex = 0; $headerIndex -lt $headers.Count; $headerIndex++) {
        if ($headers[$headerIndex] -isnot [string]) {
            throw "Table header $($headerIndex + 1) must be a string."
        }
        $header = [string]$headers[$headerIndex]
        if (
            [string]::IsNullOrWhiteSpace($header) -or
            $header -match '[\x00-\x1F\x7F-\x9F]'
        ) {
            throw "Table header $($headerIndex + 1) is empty or contains a control character."
        }
    }
    if ($rowEvidenceIds.Count -ne $rows.Count) {
        throw 'Table row evidence arrays must match table rows.'
    }
    $declaredEvidence = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    foreach ($evidenceId in @($SlideSpec.evidenceIds)) {
        if ($evidenceId -isnot [string]) {
            throw 'Slide evidence IDs must be strings for native tables.'
        }
        [void]$declaredEvidence.Add([string]$evidenceId)
    }
    for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
        if ($rows[$rowIndex] -isnot [Array]) {
            throw "Table row $($rowIndex + 1) must be an array."
        }
        $cells = @($rows[$rowIndex])
        if ($cells.Count -ne $headers.Count) {
            throw "Table row $($rowIndex + 1) width does not match the headers."
        }
        for ($cellIndex = 0; $cellIndex -lt $cells.Count; $cellIndex++) {
            if ($cells[$cellIndex] -isnot [string]) {
                throw "Table cell $($rowIndex + 1),$($cellIndex + 1) must be a string."
            }
            $text = [string]$cells[$cellIndex]
            if (
                [string]::IsNullOrWhiteSpace($text) -or
                $text -match '[\x00-\x1F\x7F-\x9F]'
            ) {
                throw "Table cell $($rowIndex + 1),$($cellIndex + 1) is empty or contains a control character."
            }
        }
        if ($rowEvidenceIds[$rowIndex] -isnot [Array]) {
            throw "Table row $($rowIndex + 1) evidence IDs must be an array."
        }
        $evidenceIds = @($rowEvidenceIds[$rowIndex])
        if ($evidenceIds.Count -lt 1) {
            throw "Table row $($rowIndex + 1) has no evidence IDs."
        }
        $seenEvidence = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
        for ($evidenceIndex = 0; $evidenceIndex -lt $evidenceIds.Count; $evidenceIndex++) {
            if ($evidenceIds[$evidenceIndex] -isnot [string]) {
                throw "Table row $($rowIndex + 1) evidence IDs must be strings."
            }
            $evidenceId = [string]$evidenceIds[$evidenceIndex]
            if (
                [string]::IsNullOrWhiteSpace($evidenceId) -or
                -not $seenEvidence.Add($evidenceId) -or
                -not $declaredEvidence.Contains($evidenceId)
            ) {
                throw "Table row $($rowIndex + 1) evidence IDs are invalid."
            }
        }
        if (
            $family -eq 'evaluation' -and
            [string]$cells[2] -notin @('pass', 'escalate', 'fail')
        ) {
            throw "Evaluation table row $($rowIndex + 1) has an invalid result."
        }
    }

    if (
        $columnWidths.Count -ne $headers.Count -or
        $rowHeights.Count -ne $rows.Count + 1
    ) {
        throw 'Table row or column geometry count is invalid.'
    }
    $columnWidthSum = 0.0
    for ($columnIndex = 0; $columnIndex -lt $columnWidths.Count; $columnIndex++) {
        $columnWidth = Get-FiniteTableNumber `
            -Value $columnWidths[$columnIndex] `
            -Label "table column $($columnIndex + 1) width"
        if ($columnWidth -le 0) {
            throw 'Table column widths must be positive.'
        }
        $columnWidthSum += $columnWidth
    }
    $rowHeightSum = 0.0
    for ($rowIndex = 0; $rowIndex -lt $rowHeights.Count; $rowIndex++) {
        $rowHeight = Get-FiniteTableNumber `
            -Value $rowHeights[$rowIndex] `
            -Label "table row $($rowIndex + 1) height"
        if ($rowHeight -le 0) {
            throw 'Table row heights must be positive.'
        }
        $rowHeightSum += $rowHeight
    }
    if (
        [math]::Abs($columnWidthSum - $width) -gt 0.01 -or
        [math]::Abs($rowHeightSum - $height) -gt 0.01
    ) {
        throw 'Table row or column geometry does not sum to the table bounds.'
    }

    foreach ($roleProperty in @(
        'headerFillColorRole',
        'bodyFillColorRole',
        'alternateFillColorRole',
        'lineColorRole',
        'headerFontColorRole',
        'bodyFontColorRole'
    )) {
        if ($Primitive.$roleProperty -isnot [string]) {
            throw "$roleProperty must be a string."
        }
        [void](Get-RoleColor -Theme $Theme -Role ([string]$Primitive.$roleProperty))
    }
    foreach ($transparencyProperty in @(
        'headerFillTransparency',
        'alternateFillTransparency'
    )) {
        $transparency = Get-FiniteTableNumber `
            -Value $Primitive.$transparencyProperty `
            -Label $transparencyProperty
        if ($transparency -lt 0 -or $transparency -gt 1) {
            throw "$transparencyProperty must be between zero and one."
        }
    }
    $lineWidth = Get-FiniteTableNumber -Value $Primitive.lineWidth -Label 'table line width'
    $cellMargin = Get-FiniteTableNumber -Value $Primitive.cellMargin -Label 'table cell margin'
    $headerFontSize = Get-FiniteTableNumber `
        -Value $Primitive.headerFontSize `
        -Label 'table header font size'
    $bodyFontSize = Get-FiniteTableNumber `
        -Value $Primitive.bodyFontSize `
        -Label 'table body font size'
    if (
        $lineWidth -le 0 -or
        $cellMargin -le 0 -or
        $headerFontSize -ne 8 -or
        $bodyFontSize -ne 8
    ) {
        throw 'Table line, margin, or font contract is invalid.'
    }
}

function Set-NativeTableGeometry {
    param(
        [Parameter(Mandatory = $true)]$Shape,
        [Parameter(Mandatory = $true)]$Table,
        [Parameter(Mandatory = $true)]$Primitive
    )

    $tableRows = $null
    $tableRow = $null
    $tableColumns = $null
    $tableColumn = $null
    try {
        $Shape.Left = [single]$Primitive.x
        $Shape.Top = [single]$Primitive.y
        $Shape.Width = [single]$Primitive.w
        $Shape.Height = [single]$Primitive.h

        $tableColumns = $Table.Columns
        try {
            for ($columnIndex = 1; $columnIndex -le $tableColumns.Count; $columnIndex++) {
                $tableColumn = $tableColumns.Item($columnIndex)
                try {
                    $tableColumn.Width = [single]$Primitive.columnWidths[$columnIndex - 1]
                }
                finally {
                    Release-ComRef -Reference ([ref]$tableColumn) -Label 'table geometry column'
                }
            }
        }
        finally {
            Release-ComRef -Reference ([ref]$tableColumn) -Label 'table geometry column'
            Release-ComRef -Reference ([ref]$tableColumns) -Label 'table geometry columns collection'
        }

        $tableRows = $Table.Rows
        try {
            for ($rowIndex = 1; $rowIndex -le $tableRows.Count; $rowIndex++) {
                $tableRow = $tableRows.Item($rowIndex)
                try {
                    $tableRow.Height = [single]$Primitive.rowHeights[$rowIndex - 1]
                }
                finally {
                    Release-ComRef -Reference ([ref]$tableRow) -Label 'table geometry row'
                }
            }
        }
        finally {
            Release-ComRef -Reference ([ref]$tableRow) -Label 'table geometry row'
            Release-ComRef -Reference ([ref]$tableRows) -Label 'table geometry rows collection'
        }

        $Shape.Left = [single]$Primitive.x
        $Shape.Top = [single]$Primitive.y
    }
    finally {
        Release-ComRef -Reference ([ref]$tableRow) -Label 'table geometry row'
        Release-ComRef -Reference ([ref]$tableRows) -Label 'table geometry rows collection'
        Release-ComRef -Reference ([ref]$tableColumn) -Label 'table geometry column'
        Release-ComRef -Reference ([ref]$tableColumns) -Label 'table geometry columns collection'
    }
}

function Assert-TableCellTextFits {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][bool]$IsHeader,
        [Parameter(Mandatory = $true)][int]$RowIndex,
        [Parameter(Mandatory = $true)][int]$ColumnIndex
    )

    $measureShape = $null
    $measureLine = $null
    $measureFill = $null
    $measureLegacyFrame = $null
    $measureFrame2 = $null
    $measureRange2 = $null
    $measureFont2 = $null
    $measureParagraph = $null
    try {
        $cellWidth = [single]$Primitive.columnWidths[$ColumnIndex - 1]
        $cellHeight = [single]$Primitive.rowHeights[$RowIndex - 1]
        $fontSize = if ($IsHeader) {
            [single]$Primitive.headerFontSize
        }
        else {
            [single]$Primitive.bodyFontSize
        }
        $measureShape = $Shapes.AddTextbox(
            1,
            0,
            0,
            $cellWidth,
            $cellHeight
        )
        $measureLine = $measureShape.Line
        $measureLine.Visible = 0
        $measureFill = $measureShape.Fill
        $measureFill.Visible = 0

        $measureLegacyFrame = $measureShape.TextFrame
        $measureLegacyFrame.AutoSize = 0
        $measureLegacyFrame.WordWrap = -1

        $measureFrame2 = $measureShape.TextFrame2
        $measureFrame2.MarginLeft = [single]$Primitive.cellMargin
        $measureFrame2.MarginRight = [single]$Primitive.cellMargin
        $measureFrame2.MarginTop = [single]$Primitive.cellMargin
        $measureFrame2.MarginBottom = [single]$Primitive.cellMargin
        $measureFrame2.WordWrap = -1
        $measureFrame2.AutoSize = 0
        $measureFrame2.VerticalAnchor = 3

        $measureRange2 = $measureFrame2.TextRange
        $measureRange2.Text = $Text
        $measureFont2 = $measureRange2.Font
        $measureFont2.Name = [string]$Theme.fontFamily
        $measureFont2.Size = $fontSize
        $measureFont2.Bold = if ($IsHeader) { -1 } else { 0 }
        $measureFont2.Italic = 0
        $measureParagraph = $measureRange2.ParagraphFormat
        $measureParagraph.Alignment = 1

        $availableHeight = [double]$cellHeight -
            ([double]$Primitive.cellMargin * 2) +
            2
        $availableWidth = [double]$cellWidth -
            ([double]$Primitive.cellMargin * 2) +
            2
        if (
            [double]$measureRange2.BoundHeight -gt $availableHeight -or
            [double]$measureRange2.BoundWidth -gt $availableWidth
        ) {
            throw "Table-cell overflow in $($Primitive.name) cell $RowIndex,$ColumnIndex."
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$measureParagraph) -Label 'table measurement paragraph format'
        Release-ComRef -Reference ([ref]$measureFont2) -Label 'table measurement font'
        Release-ComRef -Reference ([ref]$measureRange2) -Label 'table measurement text range'
        Release-ComRef -Reference ([ref]$measureFrame2) -Label 'table measurement text frame 2'
        Release-ComRef -Reference ([ref]$measureLegacyFrame) -Label 'table measurement legacy text frame'
        Release-ComRef -Reference ([ref]$measureFill) -Label 'table measurement shape fill'
        Release-ComRef -Reference ([ref]$measureLine) -Label 'table measurement shape line'
        if ($null -ne $measureShape) {
            try {
                $measureShape.Delete()
            }
            catch {
                $script:cleanupErrors.Add(
                    "table measurement shape delete: $($_.Exception.Message)"
                )
            }
        }
        Release-ComRef -Reference ([ref]$measureShape) -Label 'table measurement shape'
    }
}

function Add-TablePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shape = $null
    $table = $null
    $cell = $null
    $cellShape = $null
    $cellFill = $null
    $cellFillColor = $null
    $textFrame = $null
    $textRange = $null
    $font = $null
    $fontColor = $null
    $paragraph = $null
    $borders = $null
    $borderLine = $null
    $borderColor = $null
    try {
        $headers = @($Primitive.headers)
        $bodyRows = @($Primitive.rows)
        $shape = $Shapes.AddTable(
            $bodyRows.Count + 1,
            $headers.Count,
            [single]$Primitive.x,
            [single]$Primitive.y,
            [single]$Primitive.w,
            [single]$Primitive.h
        )
        $shape.Name = [string]$Primitive.name
        $table = $shape.Table
        Set-NativeTableGeometry -Shape $shape -Table $table -Primitive $Primitive

        for ($rowIndex = 1; $rowIndex -le $bodyRows.Count + 1; $rowIndex++) {
            for ($columnIndex = 1; $columnIndex -le $headers.Count; $columnIndex++) {
                $cell = $table.Cell($rowIndex, $columnIndex)
                try {
                    $cellShape = $cell.Shape
                    try {
                        $isHeader = $rowIndex -eq 1
                        $isAlternate = -not $isHeader -and (($rowIndex - 2) % 2 -eq 1)
                        $cellText = if ($isHeader) {
                            [string]$headers[$columnIndex - 1]
                        }
                        else {
                            [string]$bodyRows[$rowIndex - 2][$columnIndex - 1]
                        }
                        $fillRole = if ($isHeader) {
                            [string]$Primitive.headerFillColorRole
                        }
                        elseif ($isAlternate) {
                            [string]$Primitive.alternateFillColorRole
                        }
                        else {
                            [string]$Primitive.bodyFillColorRole
                        }
                        $fillTransparency = if ($isHeader) {
                            [single]$Primitive.headerFillTransparency
                        }
                        elseif ($isAlternate) {
                            [single]$Primitive.alternateFillTransparency
                        }
                        else {
                            [single]0
                        }

                        Assert-TableCellTextFits `
                            -Shapes $Shapes `
                            -Primitive $Primitive `
                            -Theme $Theme `
                            -Text $cellText `
                            -IsHeader $isHeader `
                            -RowIndex $rowIndex `
                            -ColumnIndex $columnIndex

                        $cellFill = $cellShape.Fill
                        try {
                            $cellFill.Visible = -1
                            $cellFill.Solid()
                            $cellFillColor = $cellFill.ForeColor
                            try {
                                $cellFillColor.RGB = Get-RoleColor -Theme $Theme -Role $fillRole
                            }
                            finally {
                                Release-ComRef -Reference ([ref]$cellFillColor) -Label 'table cell fill color'
                            }
                            $cellFill.Transparency = $fillTransparency
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$cellFillColor) -Label 'table cell fill color'
                            Release-ComRef -Reference ([ref]$cellFill) -Label 'table cell fill'
                        }

                        $textFrame = $cellShape.TextFrame
                        try {
                            $textFrame.MarginLeft = [single]$Primitive.cellMargin
                            $textFrame.MarginRight = [single]$Primitive.cellMargin
                            $textFrame.MarginTop = [single]$Primitive.cellMargin
                            $textFrame.MarginBottom = [single]$Primitive.cellMargin
                            $textFrame.VerticalAnchor = 3
                            $textRange = $textFrame.TextRange
                            try {
                                $textRange.Text = $cellText
                                $font = $textRange.Font
                                try {
                                    $font.Name = [string]$Theme.fontFamily
                                    $font.Size = if ($isHeader) {
                                        [single]$Primitive.headerFontSize
                                    }
                                    else {
                                        [single]$Primitive.bodyFontSize
                                    }
                                    $font.Bold = if ($isHeader) { -1 } else { 0 }
                                    $font.Italic = 0
                                    $fontColor = $font.Color
                                    try {
                                        $fontColor.RGB = Get-RoleColor `
                                            -Theme $Theme `
                                            -Role $(if ($isHeader) {
                                                [string]$Primitive.headerFontColorRole
                                            }
                                            else {
                                                [string]$Primitive.bodyFontColorRole
                                            })
                                    }
                                    finally {
                                        Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
                                    }
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
                                    Release-ComRef -Reference ([ref]$font) -Label 'table cell font'
                                }
                                $paragraph = $textRange.ParagraphFormat
                                try {
                                    $paragraph.Alignment = 1
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$paragraph) -Label 'table cell paragraph format'
                                }
                            }
                            finally {
                                Release-ComRef -Reference ([ref]$paragraph) -Label 'table cell paragraph format'
                                Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
                                Release-ComRef -Reference ([ref]$font) -Label 'table cell font'
                                Release-ComRef -Reference ([ref]$textRange) -Label 'table cell text range'
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$paragraph) -Label 'table cell paragraph format'
                            Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
                            Release-ComRef -Reference ([ref]$font) -Label 'table cell font'
                            Release-ComRef -Reference ([ref]$textRange) -Label 'table cell text range'
                            Release-ComRef -Reference ([ref]$textFrame) -Label 'table cell text frame'
                        }

                        $borders = $cell.Borders
                        try {
                            foreach ($borderType in @(1, 2, 3, 4)) {
                                $borderLine = $borders.Item($borderType)
                                try {
                                    $borderLine.Visible = -1
                                    $borderLine.Weight = [single]$Primitive.lineWidth
                                    $borderLine.DashStyle = 1
                                    $borderLine.Transparency = 0
                                    $borderColor = $borderLine.ForeColor
                                    try {
                                        $borderColor.RGB = Get-RoleColor `
                                            -Theme $Theme `
                                            -Role ([string]$Primitive.lineColorRole)
                                    }
                                    finally {
                                        Release-ComRef -Reference ([ref]$borderColor) -Label 'table cell border color'
                                    }
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$borderColor) -Label 'table cell border color'
                                    Release-ComRef -Reference ([ref]$borderLine) -Label 'table cell border line'
                                }
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$borderColor) -Label 'table cell border color'
                            Release-ComRef -Reference ([ref]$borderLine) -Label 'table cell border line'
                            Release-ComRef -Reference ([ref]$borders) -Label 'table cell borders collection'
                        }
                    }
                    finally {
                        Release-ComRef -Reference ([ref]$borderColor) -Label 'table cell border color'
                        Release-ComRef -Reference ([ref]$borderLine) -Label 'table cell border line'
                        Release-ComRef -Reference ([ref]$borders) -Label 'table cell borders collection'
                        Release-ComRef -Reference ([ref]$paragraph) -Label 'table cell paragraph format'
                        Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
                        Release-ComRef -Reference ([ref]$font) -Label 'table cell font'
                        Release-ComRef -Reference ([ref]$textRange) -Label 'table cell text range'
                        Release-ComRef -Reference ([ref]$textFrame) -Label 'table cell text frame'
                        Release-ComRef -Reference ([ref]$cellFillColor) -Label 'table cell fill color'
                        Release-ComRef -Reference ([ref]$cellFill) -Label 'table cell fill'
                        Release-ComRef -Reference ([ref]$cellShape) -Label 'table cell shape'
                    }
                }
                finally {
                    Release-ComRef -Reference ([ref]$cell) -Label 'table cell'
                }
            }
        }
        Set-NativeTableGeometry -Shape $shape -Table $table -Primitive $Primitive
    }
    finally {
        Release-ComRef -Reference ([ref]$borderColor) -Label 'table cell border color'
        Release-ComRef -Reference ([ref]$borderLine) -Label 'table cell border line'
        Release-ComRef -Reference ([ref]$borders) -Label 'table cell borders collection'
        Release-ComRef -Reference ([ref]$paragraph) -Label 'table cell paragraph format'
        Release-ComRef -Reference ([ref]$fontColor) -Label 'table cell font color'
        Release-ComRef -Reference ([ref]$font) -Label 'table cell font'
        Release-ComRef -Reference ([ref]$textRange) -Label 'table cell text range'
        Release-ComRef -Reference ([ref]$textFrame) -Label 'table cell text frame'
        Release-ComRef -Reference ([ref]$cellFillColor) -Label 'table cell fill color'
        Release-ComRef -Reference ([ref]$cellFill) -Label 'table cell fill'
        Release-ComRef -Reference ([ref]$cellShape) -Label 'table cell shape'
        Release-ComRef -Reference ([ref]$cell) -Label 'table cell'
        Release-ComRef -Reference ([ref]$table) -Label 'native table'
        Release-ComRef -Reference ([ref]$shape) -Label 'native table shape'
    }
}

function Assert-WithinTableTolerance {
    param(
        [Parameter(Mandatory = $true)][double]$Actual,
        [Parameter(Mandatory = $true)][double]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([math]::Abs($Actual - $Expected) -gt 2) {
        throw "$Label differs from the drawing spec: expected $Expected, found $Actual."
    }
}

function Assert-TablePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    $shape = $null
    $table = $null
    $tableRows = $null
    $tableRow = $null
    $tableColumns = $null
    $tableColumn = $null
    $cell = $null
    $cellShape = $null
    $cellFill = $null
    $cellFillColor = $null
    $textFrame = $null
    $textRange = $null
    $font = $null
    $fontColor = $null
    $paragraph = $null
    $measureFrame = $null
    $measureRange = $null
    $borders = $null
    $borderLine = $null
    $borderColor = $null
    try {
        $shape = $Shapes.Item([string]$Primitive.name)
        if ([int]$shape.HasTable -ne -1) {
            throw "Shape $($Primitive.name) on slide $SlideIndex is not a native table."
        }
        Assert-WithinTableTolerance -Actual $shape.Left -Expected $Primitive.x -Label 'table left'
        Assert-WithinTableTolerance -Actual $shape.Top -Expected $Primitive.y -Label 'table top'
        Assert-WithinTableTolerance -Actual $shape.Width -Expected $Primitive.w -Label 'table width'
        Assert-WithinTableTolerance -Actual $shape.Height -Expected $Primitive.h -Label 'table height'

        $headers = @($Primitive.headers)
        $bodyRows = @($Primitive.rows)
        $table = $shape.Table
        $tableRows = $table.Rows
        try {
            if ($tableRows.Count -ne $bodyRows.Count + 1) {
                throw "Table $($Primitive.name) row count changed on slide $SlideIndex."
            }
            for ($rowIndex = 1; $rowIndex -le $tableRows.Count; $rowIndex++) {
                $tableRow = $tableRows.Item($rowIndex)
                try {
                    Assert-WithinTableTolerance `
                        -Actual $tableRow.Height `
                        -Expected $Primitive.rowHeights[$rowIndex - 1] `
                        -Label "table row $rowIndex height"
                }
                finally {
                    Release-ComRef -Reference ([ref]$tableRow) -Label 'verified table row'
                }
            }
        }
        finally {
            Release-ComRef -Reference ([ref]$tableRow) -Label 'verified table row'
            Release-ComRef -Reference ([ref]$tableRows) -Label 'verified table rows collection'
        }
        $tableColumns = $table.Columns
        try {
            if ($tableColumns.Count -ne $headers.Count) {
                throw "Table $($Primitive.name) column count changed on slide $SlideIndex."
            }
            for ($columnIndex = 1; $columnIndex -le $tableColumns.Count; $columnIndex++) {
                $tableColumn = $tableColumns.Item($columnIndex)
                try {
                    Assert-WithinTableTolerance `
                        -Actual $tableColumn.Width `
                        -Expected $Primitive.columnWidths[$columnIndex - 1] `
                        -Label "table column $columnIndex width"
                }
                finally {
                    Release-ComRef -Reference ([ref]$tableColumn) -Label 'verified table column'
                }
            }
        }
        finally {
            Release-ComRef -Reference ([ref]$tableColumn) -Label 'verified table column'
            Release-ComRef -Reference ([ref]$tableColumns) -Label 'verified table columns collection'
        }

        $expectedTop = [double]$Primitive.y
        for ($rowIndex = 1; $rowIndex -le $bodyRows.Count + 1; $rowIndex++) {
            $expectedLeft = [double]$Primitive.x
            for ($columnIndex = 1; $columnIndex -le $headers.Count; $columnIndex++) {
                $cell = $table.Cell($rowIndex, $columnIndex)
                try {
                    $cellShape = $cell.Shape
                    try {
                        $isHeader = $rowIndex -eq 1
                        $isAlternate = -not $isHeader -and (($rowIndex - 2) % 2 -eq 1)
                        $expectedText = if ($isHeader) {
                            [string]$headers[$columnIndex - 1]
                        }
                        else {
                            [string]$bodyRows[$rowIndex - 2][$columnIndex - 1]
                        }
                        $fillRole = if ($isHeader) {
                            [string]$Primitive.headerFillColorRole
                        }
                        elseif ($isAlternate) {
                            [string]$Primitive.alternateFillColorRole
                        }
                        else {
                            [string]$Primitive.bodyFillColorRole
                        }
                        $fillTransparency = if ($isHeader) {
                            [double]$Primitive.headerFillTransparency
                        }
                        elseif ($isAlternate) {
                            [double]$Primitive.alternateFillTransparency
                        }
                        else {
                            0.0
                        }
                        Assert-WithinTableTolerance `
                            -Actual $cellShape.Left `
                            -Expected $expectedLeft `
                            -Label "table cell $rowIndex,$columnIndex left"
                        Assert-WithinTableTolerance `
                            -Actual $cellShape.Top `
                            -Expected $expectedTop `
                            -Label "table cell $rowIndex,$columnIndex top"
                        Assert-WithinTableTolerance `
                            -Actual $cellShape.Width `
                            -Expected $Primitive.columnWidths[$columnIndex - 1] `
                            -Label "table cell $rowIndex,$columnIndex width"
                        Assert-WithinTableTolerance `
                            -Actual $cellShape.Height `
                            -Expected $Primitive.rowHeights[$rowIndex - 1] `
                            -Label "table cell $rowIndex,$columnIndex height"

                        $cellFill = $cellShape.Fill
                        try {
                            if ([int]$cellFill.Visible -ne -1) {
                                throw "Table cell $rowIndex,$columnIndex fill is hidden."
                            }
                            $cellFillColor = $cellFill.ForeColor
                            try {
                                $expectedFillColor = Get-RoleColor -Theme $Theme -Role $fillRole
                                if ([int]$cellFillColor.RGB -ne $expectedFillColor) {
                                    throw "Table cell $rowIndex,$columnIndex fill color changed."
                                }
                            }
                            finally {
                                Release-ComRef -Reference ([ref]$cellFillColor) -Label 'verified table cell fill color'
                            }
                            if ([math]::Abs([double]$cellFill.Transparency - $fillTransparency) -gt 0.01) {
                                throw "Table cell $rowIndex,$columnIndex fill transparency changed."
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$cellFillColor) -Label 'verified table cell fill color'
                            Release-ComRef -Reference ([ref]$cellFill) -Label 'verified table cell fill'
                        }

                        $textFrame = $cellShape.TextFrame
                        try {
                            foreach ($marginProperty in @(
                                'MarginLeft',
                                'MarginRight',
                                'MarginTop',
                                'MarginBottom'
                            )) {
                                Assert-WithinTableTolerance `
                                    -Actual $textFrame.$marginProperty `
                                    -Expected $Primitive.cellMargin `
                                    -Label "table cell $rowIndex,$columnIndex $marginProperty"
                            }
                            if ([int]$textFrame.VerticalAnchor -ne 3) {
                                throw "Table cell $rowIndex,$columnIndex vertical alignment changed."
                            }
                            $textRange = $textFrame.TextRange
                            try {
                                if (-not [string]::Equals(
                                    [string]$textRange.Text,
                                    $expectedText,
                                    [StringComparison]::Ordinal
                                )) {
                                    throw "Table cell $rowIndex,$columnIndex content changed."
                                }
                                $font = $textRange.Font
                                try {
                                    $expectedFontSize = if ($isHeader) {
                                        [double]$Primitive.headerFontSize
                                    }
                                    else {
                                        [double]$Primitive.bodyFontSize
                                    }
                                    if (
                                        -not [string]::Equals(
                                            [string]$font.Name,
                                            [string]$Theme.fontFamily,
                                            [StringComparison]::Ordinal
                                        ) -or
                                        [math]::Abs([double]$font.Size - $expectedFontSize) -gt 0.01 -or
                                        [int]$font.Bold -ne $(if ($isHeader) { -1 } else { 0 }) -or
                                        [int]$font.Italic -ne 0
                                    ) {
                                        throw "Table cell $rowIndex,$columnIndex typography changed."
                                    }
                                    $fontColor = $font.Color
                                    try {
                                        $fontRole = if ($isHeader) {
                                            [string]$Primitive.headerFontColorRole
                                        }
                                        else {
                                            [string]$Primitive.bodyFontColorRole
                                        }
                                        if (
                                            [int]$fontColor.RGB -ne
                                            (Get-RoleColor -Theme $Theme -Role $fontRole)
                                        ) {
                                            throw "Table cell $rowIndex,$columnIndex font color changed."
                                        }
                                    }
                                    finally {
                                        Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
                                    }
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
                                    Release-ComRef -Reference ([ref]$font) -Label 'verified table cell font'
                                }
                                $paragraph = $textRange.ParagraphFormat
                                try {
                                    if ([int]$paragraph.Alignment -ne 1) {
                                        throw "Table cell $rowIndex,$columnIndex horizontal alignment changed."
                                    }
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$paragraph) -Label 'verified table cell paragraph format'
                                }
                            }
                            finally {
                                Release-ComRef -Reference ([ref]$paragraph) -Label 'verified table cell paragraph format'
                                Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
                                Release-ComRef -Reference ([ref]$font) -Label 'verified table cell font'
                                Release-ComRef -Reference ([ref]$textRange) -Label 'verified table cell text range'
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$paragraph) -Label 'verified table cell paragraph format'
                            Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
                            Release-ComRef -Reference ([ref]$font) -Label 'verified table cell font'
                            Release-ComRef -Reference ([ref]$textRange) -Label 'verified table cell text range'
                            Release-ComRef -Reference ([ref]$textFrame) -Label 'verified table cell text frame'
                        }

                        $measureFrame = $cellShape.TextFrame2
                        try {
                            $measureRange = $measureFrame.TextRange
                            try {
                                $availableHeight = [double]$cellShape.Height -
                                    ([double]$Primitive.cellMargin * 2) +
                                    2
                                $availableWidth = [double]$cellShape.Width -
                                    ([double]$Primitive.cellMargin * 2) +
                                    2
                                if (
                                    [double]$measureRange.BoundHeight -gt $availableHeight -or
                                    [double]$measureRange.BoundWidth -gt $availableWidth
                                ) {
                                    throw "Table-cell overflow in $($Primitive.name) cell $rowIndex,$columnIndex on slide $SlideIndex."
                                }
                            }
                            finally {
                                Release-ComRef -Reference ([ref]$measureRange) -Label 'table cell overflow text range'
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$measureRange) -Label 'table cell overflow text range'
                            Release-ComRef -Reference ([ref]$measureFrame) -Label 'table cell overflow text frame'
                        }

                        $borders = $cell.Borders
                        try {
                            foreach ($borderType in @(1, 2, 3, 4)) {
                                $borderLine = $borders.Item($borderType)
                                try {
                                    if (
                                        [int]$borderLine.Visible -ne -1 -or
                                        [math]::Abs(
                                            [double]$borderLine.Weight -
                                            [double]$Primitive.lineWidth
                                        ) -gt 0.01 -or
                                        [int]$borderLine.DashStyle -ne 1 -or
                                        [math]::Abs([double]$borderLine.Transparency) -gt 0.01
                                    ) {
                                        throw "Table cell $rowIndex,$columnIndex border style changed."
                                    }
                                    $borderColor = $borderLine.ForeColor
                                    try {
                                        if (
                                            [int]$borderColor.RGB -ne
                                            (Get-RoleColor `
                                                -Theme $Theme `
                                                -Role ([string]$Primitive.lineColorRole))
                                        ) {
                                            throw "Table cell $rowIndex,$columnIndex border color changed."
                                        }
                                    }
                                    finally {
                                        Release-ComRef -Reference ([ref]$borderColor) -Label 'verified table cell border color'
                                    }
                                }
                                finally {
                                    Release-ComRef -Reference ([ref]$borderColor) -Label 'verified table cell border color'
                                    Release-ComRef -Reference ([ref]$borderLine) -Label 'verified table cell border line'
                                }
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$borderColor) -Label 'verified table cell border color'
                            Release-ComRef -Reference ([ref]$borderLine) -Label 'verified table cell border line'
                            Release-ComRef -Reference ([ref]$borders) -Label 'verified table cell borders collection'
                        }
                    }
                    finally {
                        Release-ComRef -Reference ([ref]$borderColor) -Label 'verified table cell border color'
                        Release-ComRef -Reference ([ref]$borderLine) -Label 'verified table cell border line'
                        Release-ComRef -Reference ([ref]$borders) -Label 'verified table cell borders collection'
                        Release-ComRef -Reference ([ref]$measureRange) -Label 'table cell overflow text range'
                        Release-ComRef -Reference ([ref]$measureFrame) -Label 'table cell overflow text frame'
                        Release-ComRef -Reference ([ref]$paragraph) -Label 'verified table cell paragraph format'
                        Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
                        Release-ComRef -Reference ([ref]$font) -Label 'verified table cell font'
                        Release-ComRef -Reference ([ref]$textRange) -Label 'verified table cell text range'
                        Release-ComRef -Reference ([ref]$textFrame) -Label 'verified table cell text frame'
                        Release-ComRef -Reference ([ref]$cellFillColor) -Label 'verified table cell fill color'
                        Release-ComRef -Reference ([ref]$cellFill) -Label 'verified table cell fill'
                        Release-ComRef -Reference ([ref]$cellShape) -Label 'verified table cell shape'
                    }
                }
                finally {
                    Release-ComRef -Reference ([ref]$cell) -Label 'verified table cell'
                }
                $expectedLeft += [double]$Primitive.columnWidths[$columnIndex - 1]
            }
            $expectedTop += [double]$Primitive.rowHeights[$rowIndex - 1]
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$borderColor) -Label 'verified table cell border color'
        Release-ComRef -Reference ([ref]$borderLine) -Label 'verified table cell border line'
        Release-ComRef -Reference ([ref]$borders) -Label 'verified table cell borders collection'
        Release-ComRef -Reference ([ref]$measureRange) -Label 'table cell overflow text range'
        Release-ComRef -Reference ([ref]$measureFrame) -Label 'table cell overflow text frame'
        Release-ComRef -Reference ([ref]$paragraph) -Label 'verified table cell paragraph format'
        Release-ComRef -Reference ([ref]$fontColor) -Label 'verified table cell font color'
        Release-ComRef -Reference ([ref]$font) -Label 'verified table cell font'
        Release-ComRef -Reference ([ref]$textRange) -Label 'verified table cell text range'
        Release-ComRef -Reference ([ref]$textFrame) -Label 'verified table cell text frame'
        Release-ComRef -Reference ([ref]$cellFillColor) -Label 'verified table cell fill color'
        Release-ComRef -Reference ([ref]$cellFill) -Label 'verified table cell fill'
        Release-ComRef -Reference ([ref]$cellShape) -Label 'verified table cell shape'
        Release-ComRef -Reference ([ref]$cell) -Label 'verified table cell'
        Release-ComRef -Reference ([ref]$tableColumn) -Label 'verified table column'
        Release-ComRef -Reference ([ref]$tableColumns) -Label 'verified table columns collection'
        Release-ComRef -Reference ([ref]$tableRow) -Label 'verified table row'
        Release-ComRef -Reference ([ref]$tableRows) -Label 'verified table rows collection'
        Release-ComRef -Reference ([ref]$table) -Label 'verified native table'
        Release-ComRef -Reference ([ref]$shape) -Label 'verified native table shape'
    }
}

function Assert-NativeTables {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$SlideSpec,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shapes = $null
    try {
        $shapes = $Slide.Shapes
        for ($primitiveIndex = 0; $primitiveIndex -lt $SlideSpec.primitives.Count; $primitiveIndex++) {
            $primitive = $SlideSpec.primitives[$primitiveIndex]
            if ([string]$primitive.kind -eq 'table') {
                Assert-TablePrimitive `
                    -Shapes $shapes `
                    -Primitive $primitive `
                    -Theme $Theme `
                    -SlideIndex ([int]$Slide.SlideIndex)
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$shapes) -Label 'native table verification shapes'
    }
}

function Invoke-TestTableMutation {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$SlideSpec
    )

    if (
        $env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1' -or
        $env:FDE_POWERPOINT_TEST_MUTATE_TABLE_BEFORE_VERIFY -ne '1'
    ) {
        return $false
    }
    $tablePrimitive = @(
        $SlideSpec.primitives |
            Where-Object { [string]$_.kind -eq 'table' } |
            Select-Object -First 1
    )
    if ($tablePrimitive.Count -eq 0) {
        return $false
    }

    $shapes = $null
    $shape = $null
    $table = $null
    $cell = $null
    $cellShape = $null
    $textFrame = $null
    $textRange = $null
    try {
        $shapes = $Slide.Shapes
        $shape = $shapes.Item([string]$tablePrimitive[0].name)
        $table = $shape.Table
        $cell = $table.Cell(1, 1)
        $cellShape = $cell.Shape
        $textFrame = $cellShape.TextFrame
        $textRange = $textFrame.TextRange
        $textRange.Text = "$($textRange.Text) test-mutation"
        return $true
    }
    finally {
        Release-ComRef -Reference ([ref]$textRange) -Label 'mutated table cell text range'
        Release-ComRef -Reference ([ref]$textFrame) -Label 'mutated table cell text frame'
        Release-ComRef -Reference ([ref]$cellShape) -Label 'mutated table cell shape'
        Release-ComRef -Reference ([ref]$cell) -Label 'mutated table cell'
        Release-ComRef -Reference ([ref]$table) -Label 'mutated native table'
        Release-ComRef -Reference ([ref]$shape) -Label 'mutated native table shape'
        Release-ComRef -Reference ([ref]$shapes) -Label 'mutated native table shapes'
    }
}

function Add-WorkflowConnectorPrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $shape = $null
    $line = $null
    $lineColor = $null
    try {
        $shape = $Shapes.AddConnector(
            1,
            [single]$Primitive.x1,
            [single]$Primitive.y1,
            [single]$Primitive.x2,
            [single]$Primitive.y2
        )
        $shape.Name = [string]$Primitive.name
        if ([int]$shape.ZOrderPosition -ne [int]$Primitive.z) {
            throw "Connector z-order does not match $($Primitive.name)."
        }
        $line = $shape.Line
        $lineColor = $line.ForeColor
        $lineColor.RGB = Get-RoleColor -Theme $Theme -Role ([string]$Primitive.colorRole)
        $line.Transparency = [single]$Primitive.transparency
        $line.Weight = [single]$Primitive.width
        $line.DashStyle = Get-DashStyle -Dash ([string]$Primitive.dash)
        $line.BeginArrowheadStyle = 1
        $line.EndArrowheadStyle = if ($Primitive.arrowEnd -ceq 'open') { 3 } else { 1 }
    }
    finally {
        Release-ComRef -Reference ([ref]$lineColor) -Label 'workflow connector line color'
        Release-ComRef -Reference ([ref]$line) -Label 'workflow connector line format'
        Release-ComRef -Reference ([ref]$shape) -Label 'workflow connector shape'
    }
}

function Get-WorkflowConnectorEndpoints {
    param([Parameter(Mandatory = $true)]$Shape)

    $left = [single]$Shape.Left
    $top = [single]$Shape.Top
    $right = [single]($left + [single]$Shape.Width)
    $bottom = [single]($top + [single]$Shape.Height)
    $horizontalFlip = [int]$Shape.HorizontalFlip -eq -1
    $verticalFlip = [int]$Shape.VerticalFlip -eq -1
    return [pscustomobject]@{
        x1 = if ($horizontalFlip) { $right } else { $left }
        y1 = if ($verticalFlip) { $bottom } else { $top }
        x2 = if ($horizontalFlip) { $left } else { $right }
        y2 = if ($verticalFlip) { $top } else { $bottom }
    }
}

function Assert-WorkflowConnectorShape {
    param(
        [Parameter(Mandatory = $true)]$Shape,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    $line = $null
    $lineColor = $null
    try {
        if (
            [int]$Shape.Connector -ne -1 -or
            -not [string]::Equals(
                [string]$Shape.Name,
                [string]$Primitive.name,
                [StringComparison]::Ordinal
            ) -or
            [int]$Shape.ZOrderPosition -ne [int]$Primitive.z
        ) {
            throw "Reopened connector identity or z-order changed on slide $SlideIndex."
        }
        $endpoints = Get-WorkflowConnectorEndpoints -Shape $Shape
        if (
            [single]$endpoints.x1 -ne [single]$Primitive.x1 -or
            [single]$endpoints.y1 -ne [single]$Primitive.y1 -or
            [single]$endpoints.x2 -ne [single]$Primitive.x2 -or
            [single]$endpoints.y2 -ne [single]$Primitive.y2
        ) {
            throw "Reopened connector geometry changed for $($Primitive.name) on slide $SlideIndex."
        }
        $line = $Shape.Line
        $lineColor = $line.ForeColor
        if (
            [int]$lineColor.RGB -ne (
                Get-RoleColor -Theme $Theme -Role ([string]$Primitive.colorRole)
            ) -or
            [single]$line.Transparency -ne [single]$Primitive.transparency -or
            [single]$line.Weight -ne [single]$Primitive.width -or
            [int]$line.DashStyle -ne (
                Get-DashStyle -Dash ([string]$Primitive.dash)
            ) -or
            [int]$line.BeginArrowheadStyle -ne 1 -or
            [int]$line.EndArrowheadStyle -ne $(if ($Primitive.arrowEnd -ceq 'open') { 3 } else { 1 })
        ) {
            throw "Reopened connector style changed for $($Primitive.name) on slide $SlideIndex."
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$lineColor) -Label 'reopened workflow connector line color'
        Release-ComRef -Reference ([ref]$line) -Label 'reopened workflow connector line format'
    }
}

function Assert-WorkflowConnectors {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$SlideSpec,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    $shapes = $null
    $shape = $null
    $verified = 0
    try {
        $shapes = $Slide.Shapes
        $primitives = @($SlideSpec.primitives)
        for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
            $primitive = $primitives[$primitiveIndex]
            if (-not (Test-WorkflowConnectorPrimitive -Primitive $primitive)) {
                continue
            }
            $shape = $shapes.Item($primitiveIndex + 1)
            try {
                Assert-WorkflowConnectorShape `
                    -Shape $shape `
                    -Primitive $primitive `
                    -Theme $Theme `
                    -SlideIndex $SlideIndex
                $verified += 1
            }
            finally {
                Release-ComRef -Reference ([ref]$shape) -Label 'reopened workflow connector shape'
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$shape) -Label 'reopened workflow connector shape'
        Release-ComRef -Reference ([ref]$shapes) -Label 'reopened workflow connector shapes'
    }
    return $verified
}

function Invoke-WorkflowConnectorMutationHook {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$SlideSpec
    )

    $shapes = $null
    $shape = $null
    try {
        $shapes = $Slide.Shapes
        $primitives = @($SlideSpec.primitives)
        for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
            if (-not (Test-WorkflowConnectorPrimitive -Primitive $primitives[$primitiveIndex])) {
                continue
            }
            $shape = $shapes.Item($primitiveIndex + 1)
            $shape.Left = [single]$shape.Left + 1
            return
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$shape) -Label 'mutated workflow connector shape'
        Release-ComRef -Reference ([ref]$shapes) -Label 'mutated workflow connector shapes'
    }
    throw 'Connector mutation hook requires at least one workflow connector.'
}

function Get-NativeNotesText {
    param([Parameter(Mandatory = $true)]$Slide)

    $notesPage = $null
    $notesShapes = $null
    $shape = $null
    $placeholder = $null
    $legacyFrame = $null
    $legacyRange = $null
    try {
        $notesPage = $Slide.NotesPage
        $notesShapes = $notesPage.Shapes
        $shapeCount = $notesShapes.Count
        for ($index = 1; $index -le $shapeCount; $index++) {
            $shape = $notesShapes.Item($index)
            try {
                if ($shape.Type -ne 14) {
                    continue
                }
                $placeholder = $shape.PlaceholderFormat
                try {
                    if ($placeholder.Type -ne 2) {
                        continue
                    }
                }
                finally {
                    Release-ComRef -Reference ([ref]$placeholder) -Label 'notes placeholder format'
                }
                $legacyFrame = $shape.TextFrame
                $legacyRange = $legacyFrame.TextRange
                return [string]$legacyRange.Text
            }
            finally {
                Release-ComRef -Reference ([ref]$legacyRange) -Label 'notes text range'
                Release-ComRef -Reference ([ref]$legacyFrame) -Label 'notes text frame'
                Release-ComRef -Reference ([ref]$placeholder) -Label 'notes placeholder format'
                Release-ComRef -Reference ([ref]$shape) -Label 'notes shape'
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$legacyRange) -Label 'notes text range'
        Release-ComRef -Reference ([ref]$legacyFrame) -Label 'notes text frame'
        Release-ComRef -Reference ([ref]$placeholder) -Label 'notes placeholder format'
        Release-ComRef -Reference ([ref]$shape) -Label 'notes shape'
        Release-ComRef -Reference ([ref]$notesShapes) -Label 'notes shapes'
        Release-ComRef -Reference ([ref]$notesPage) -Label 'notes page'
    }
    throw "Slide $($Slide.SlideIndex) has no notes-body placeholder."
}

function Remove-SeedShapes {
    param([Parameter(Mandatory = $true)]$Shapes)

    for ($index = $Shapes.Count; $index -ge 1; $index--) {
        $shape = $null
        try {
            $shape = $Shapes.Item($index)
            $shape.Delete()
        }
        finally {
            Release-ComRef -Reference ([ref]$shape) -Label 'seed shape'
        }
    }
}

function Assert-TextFits {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)]$SlideSpec
    )

    $shapes = $null
    $shape = $null
    $frame2 = $null
    $range2 = $null
    $lines = $null
    try {
        $shapes = $Slide.Shapes
        $shapeCount = $shapes.Count
        for ($index = 1; $index -le $shapeCount; $index++) {
            $shape = $shapes.Item($index)
            try {
                if ($shape.HasTextFrame -ne -1) {
                    continue
                }
                $frame2 = $shape.TextFrame2
                try {
                    if ($frame2.HasText -ne -1) {
                        continue
                    }
                    if ($frame2.AutoSize -ne 0) {
                        throw "Text shrink or auto-size is enabled in $($shape.Name)."
                    }
                    $range2 = $frame2.TextRange
                    try {
                        $availableHeight = [single]$shape.Height -
                            [single]$frame2.MarginTop -
                            [single]$frame2.MarginBottom +
                            2
                        $availableWidth = [single]$shape.Width -
                            [single]$frame2.MarginLeft -
                            [single]$frame2.MarginRight +
                            2
                        if ([single]$range2.BoundHeight -gt $availableHeight) {
                            throw "Text overflow in $($shape.Name) on slide $($Slide.SlideIndex)."
                        }
                        if ($frame2.WordWrap -eq 0 -and [single]$range2.BoundWidth -gt $availableWidth) {
                            throw "Text width overflow in $($shape.Name) on slide $($Slide.SlideIndex)."
                        }

                        $primitive = $null
                        for ($primitiveIndex = 0; $primitiveIndex -lt $SlideSpec.primitives.Count; $primitiveIndex++) {
                            if ([string]$SlideSpec.primitives[$primitiveIndex].name -eq [string]$shape.Name) {
                                $primitive = $SlideSpec.primitives[$primitiveIndex]
                                break
                            }
                        }
                        if ($null -eq $primitive -or [string]$primitive.kind -ne 'text') {
                            throw "Text shape $($shape.Name) has no matching text primitive."
                        }
                        $lines = $range2.Lines()
                        try {
                            $renderedLineCount = [int]$lines.Count
                            if ($renderedLineCount -gt [int]$primitive.maxLines) {
                                throw "Text in $($shape.Name) renders as $renderedLineCount lines, exceeding maxLines $($primitive.maxLines)."
                            }
                        }
                        finally {
                            Release-ComRef -Reference ([ref]$lines) -Label 'rendered text lines'
                        }
                    }
                    finally {
                        Release-ComRef -Reference ([ref]$lines) -Label 'rendered text lines'
                        Release-ComRef -Reference ([ref]$range2) -Label 'overflow text range'
                    }
                }
                finally {
                    Release-ComRef -Reference ([ref]$frame2) -Label 'overflow text frame'
                }
            }
            finally {
                Release-ComRef -Reference ([ref]$lines) -Label 'rendered text lines'
                Release-ComRef -Reference ([ref]$range2) -Label 'overflow text range'
                Release-ComRef -Reference ([ref]$frame2) -Label 'overflow text frame'
                Release-ComRef -Reference ([ref]$shape) -Label 'overflow shape'
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$lines) -Label 'rendered text lines'
        Release-ComRef -Reference ([ref]$range2) -Label 'overflow text range'
        Release-ComRef -Reference ([ref]$frame2) -Label 'overflow text frame'
        Release-ComRef -Reference ([ref]$shape) -Label 'overflow shape'
        Release-ComRef -Reference ([ref]$shapes) -Label 'overflow shapes'
    }
}

function Get-ShapeNames {
    param([Parameter(Mandatory = $true)]$Slide)

    $names = [System.Collections.Generic.List[string]]::new()
    $shapes = $null
    $shape = $null
    try {
        $shapes = $Slide.Shapes
        $shapeCount = $shapes.Count
        for ($index = 1; $index -le $shapeCount; $index++) {
            $shape = $shapes.Item($index)
            try {
                $names.Add([string]$shape.Name)
            }
            finally {
                Release-ComRef -Reference ([ref]$shape) -Label 'verification shape'
            }
        }
        return $names.ToArray()
    }
    finally {
        Release-ComRef -Reference ([ref]$shape) -Label 'verification shape'
        Release-ComRef -Reference ([ref]$shapes) -Label 'verification shapes'
    }
}

function Assert-ExactShapeNames {
    param(
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string[]]$Actual,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    if ($Expected.Count -ne $Actual.Count) {
        throw "Final shape count does not match the spec on slide $SlideIndex."
    }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if (-not [string]::Equals($Expected[$index], $Actual[$index], [StringComparison]::Ordinal)) {
            throw "Final shape names do not match the spec on slide $SlideIndex."
        }
    }
}

function New-ContactSheet {
    param(
        [Parameter(Mandatory = $true)][string[]]$Images,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    Add-Type -AssemblyName System.Drawing
    $columns = [math]::Min(3, $Images.Count)
    $rows = [math]::Ceiling($Images.Count / $columns)
    $cellWidth = 480
    $cellHeight = 270
    $bitmap = [Drawing.Bitmap]::new($columns * $cellWidth, $rows * $cellHeight)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::White)
        for ($index = 0; $index -lt $Images.Count; $index++) {
            $image = [Drawing.Image]::FromFile($Images[$index])
            try {
                $x = ($index % $columns) * $cellWidth
                $y = [math]::Floor($index / $columns) * $cellHeight
                $graphics.DrawImage($image, $x, $y, $cellWidth, $cellHeight)
            }
            finally {
                $image.Dispose()
            }
        }
        $bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Assert-PngDimensions {
    param([Parameter(Mandatory = $true)][string]$Path)

    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Image]::FromFile($Path)
    try {
        if ($image.Width -ne 1600 -or $image.Height -ne 900) {
            throw "Rendered slide has invalid dimensions $($image.Width)x$($image.Height): $Path."
        }
    }
    finally {
        $image.Dispose()
    }
}

function Get-PowerPointProcesses {
    $processes = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
    $identities = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $processes.Count; $index++) {
        $process = $processes[$index]
        try {
            $identities.Add("$($process.Id)|$($process.StartTime.ToUniversalTime().Ticks)")
        }
        catch {
            throw "Could not capture PowerPoint process identity for PID $($process.Id)."
        }
        finally {
            $process.Dispose()
        }
    }
    return ,$identities.ToArray()
}

function Assert-NoPowerPointContamination {
    param(
        [Parameter(Mandatory = $true)][int]$OwnedProcessId,
        [Parameter(Mandatory = $true)][DateTime]$OwnedProcessStart
    )

    $ownedIdentity = "$OwnedProcessId|$($OwnedProcessStart.ToUniversalTime().Ticks)"
    $current = Get-PowerPointProcesses
    for ($index = 0; $index -lt $current.Count; $index++) {
        $identity = $current[$index]
        if ($identity -ne $ownedIdentity) {
            throw "Unattributable PowerPoint process contamination detected: $identity."
        }
    }
}

function Assert-PowerPointBaselineRestored {
    $current = Get-PowerPointProcesses
    if ($current.Count -gt 0) {
        throw "PowerPoint process contamination detected after worker cleanup: $($current -join ', ')."
    }
}

function Remove-StagedPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Release-WorkerMutex {
    if ($script:workerMutexHeld) {
        try {
            $script:workerMutex.ReleaseMutex()
        }
        catch {
            $script:cleanupErrors.Add("worker mutex release: $($_.Exception.Message)")
        }
        $script:workerMutexHeld = $false
    }
    if ($null -ne $script:workerMutex) {
        try {
            $script:workerMutex.Dispose()
        }
        catch {
            $script:cleanupErrors.Add("worker mutex dispose: $($_.Exception.Message)")
        }
        $script:workerMutex = $null
    }
}

$startedAt = [DateTimeOffset]::UtcNow
$token = if (
    $env:FDE_POWERPOINT_TEST_FAILPOINTS -eq '1' -and
    $env:FDE_POWERPOINT_TEST_STAGING_TOKEN -match '^[A-Za-z0-9-]+$'
) {
    $env:FDE_POWERPOINT_TEST_STAGING_TOKEN
}
else {
    "$PID-$([Guid]::NewGuid().ToString('N'))"
}
$powerPointGraceSeconds = 5
$powerPoint = $null
$presentations = $null
$presentation = $null
$reopened = $null
$ownedPowerPointProcess = $null
$ownedPowerPointProcessHandle = [IntPtr]::Zero
$applicationActivated = $false
$workerProcessId = 0
$workerProcessStart = $null
$workerProcessPath = $null
$hasProvisionalPowerPointProcess = $false
$ownsPowerPointProcess = $false
$powerPointCleanupMode = $null
$operationErrorMessage = $null
$cleanupErrorMessage = $null
$script:workerMutex = $null
$script:workerMutexHeld = $false
$stagingDirectory = $null
$ownsStagingDirectory = $false
$candidatePath = $null
$temporaryRenderPath = $null
$stagedReportPath = $null
$stagedSkeletonSha256 = $null
$reportObject = $null
$baselinePowerPointIdentities = @()
$nativeNotes = [System.Collections.Generic.List[string]]::new()
$slideReports = [System.Collections.Generic.List[object]]::new()
$tableMutationApplied = $false
$connectorSpecReport = $null
$connectorSlideReportById = @{}

try {
    $rawPaths = [ordered]@{
        Spec = [IO.Path]::GetFullPath($Spec)
        Skeleton = [IO.Path]::GetFullPath($Skeleton)
        OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    }
    if (-not (Test-Path -LiteralPath $rawPaths.Spec -PathType Leaf)) {
        throw "Spec does not exist as a file: $($rawPaths.Spec)."
    }
    if (-not (Test-Path -LiteralPath $rawPaths.Skeleton -PathType Leaf)) {
        throw "Skeleton does not exist as a file: $($rawPaths.Skeleton)."
    }
    $canonicalPaths = [ordered]@{
        Spec = Get-CanonicalPath -Path $rawPaths.Spec
        Skeleton = Get-CanonicalPath -Path $rawPaths.Skeleton
        OutputDirectory = Get-CanonicalPath -Path $rawPaths.OutputDirectory
    }
    Assert-IndependentPaths -Paths $canonicalPaths
    $specPath = $canonicalPaths.Spec
    $skeletonPath = $canonicalPaths.Skeleton
    $outputPath = $canonicalPaths.OutputDirectory
    $outputParent = Split-Path -Parent $outputPath
    if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
        throw "OutputDirectory parent does not exist: $outputParent."
    }
    if (Test-Path -LiteralPath $outputPath) {
        throw 'OutputDirectory must be a new path.'
    }

    $specBytes = [IO.File]::ReadAllBytes($specPath)
    $actualSpecSha256 = Get-BytesSha256 -Bytes $specBytes
    if ($ExpectedSpecSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'ExpectedSpecSha256 must be a 64-character SHA-256 digest.'
    }
    if (-not [string]::Equals($actualSpecSha256, $ExpectedSpecSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Drawing spec SHA-256 mismatch: expected $ExpectedSpecSha256, found $actualSpecSha256."
    }

    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $specJson = $strictUtf8.GetString($specBytes)
    $specObject = $specJson | ConvertFrom-Json
    $skeletonBytes = [IO.File]::ReadAllBytes($skeletonPath)
    $stagedSkeletonSha256 = Get-BytesSha256 -Bytes $skeletonBytes
    if ([string]$specObject.schemaVersion -ne 'fde-drawing-spec/1.0' -or [string]$specObject.units -ne 'points') {
        throw 'Drawing spec must use fde-drawing-spec/1.0 point units.'
    }
    if ([int]$specObject.stage.width -ne 960 -or [int]$specObject.stage.height -ne 540) {
        throw 'Drawing spec stage must be exactly 960x540.'
    }
    $slidesSpec = @($specObject.slides)
    $selectedSlideIds = @($specObject.selectedSlideIds)
    $selectedSlideFamilies = @($specObject.selectedSlideFamilies)
    if (
        $slidesSpec.Count -lt 1 -or
        $selectedSlideIds.Count -ne $slidesSpec.Count -or
        $selectedSlideFamilies.Count -ne $slidesSpec.Count
    ) {
        throw 'Drawing spec selected-slide metadata must match its nonempty slides array.'
    }
    for ($slideIndex = 0; $slideIndex -lt $slidesSpec.Count; $slideIndex++) {
        if (
            [string]$slidesSpec[$slideIndex].id -ne [string]$selectedSlideIds[$slideIndex] -or
            [string]$slidesSpec[$slideIndex].family -ne [string]$selectedSlideFamilies[$slideIndex]
        ) {
            throw "Drawing spec selected-slide metadata does not match slide $($slideIndex + 1)."
        }
        $primitives = @($slidesSpec[$slideIndex].primitives)
        for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
            $kind = [string]$primitives[$primitiveIndex].kind
            if ($kind -notin @('text', 'shape', 'line', 'table')) {
                throw "Unsupported primitive kind '$kind'. The PowerPoint worker supports text, shape, line, table, and workflow line connectors; nativeChart requires a later layer."
            }
            if ($kind -eq 'table') {
                Assert-TablePrimitiveSpec `
                    -Primitive $primitives[$primitiveIndex] `
                    -SlideSpec $slidesSpec[$slideIndex] `
                    -Theme $specObject.theme
            }
        }
    }
    $connectorSpecReport = Get-WorkflowConnectorSpecReport -SpecObject $specObject
    foreach ($connectorSlideReport in @($connectorSpecReport.slides)) {
        $connectorSlideReportById[[string]$connectorSlideReport.id] = $connectorSlideReport
    }
    if ($PSBoundParameters.ContainsKey('FailAfter') -and $env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1') {
        throw 'PowerPoint worker failpoints require FDE_POWERPOINT_TEST_FAILPOINTS=1.'
    }
    if ($env:FDE_POWERPOINT_CODE_ONLY -eq '1') {
        throw 'PowerPoint worker code-only guard prevented COM activation.'
    }
    if (
        $env:FDE_POWERPOINT_TEST_MUTATE_CONNECTOR_BEFORE_VERIFY -eq '1' -and
        $env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1'
    ) {
        throw 'Connector mutation hooks require FDE_POWERPOINT_TEST_FAILPOINTS=1.'
    }

    $stagingDirectory = Join-Path $outputParent ".$([IO.Path]::GetFileName($outputPath)).$token.worker-stage"
    $canonicalStagingDirectory = Get-CanonicalPath -Path $stagingDirectory
    $pathsWithStaging = [ordered]@{
        Spec = $specPath
        Skeleton = $skeletonPath
        OutputDirectory = $outputPath
        StagingDirectory = $canonicalStagingDirectory
    }
    Assert-IndependentPaths -Paths $pathsWithStaging
    $stagingDirectory = $canonicalStagingDirectory
    $candidatePath = Join-Path $stagingDirectory 'readout.pptx'
    $temporaryRenderPath = Join-Path $stagingDirectory 'native-render'
    $stagedReportPath = Join-Path $stagingDirectory 'worker-report.json'

    $script:workerMutex = [Threading.Mutex]::new($false, 'Local\FdeReadoutPowerPointAutomation')
    try {
        $script:workerMutexHeld = $script:workerMutex.WaitOne([TimeSpan]::FromSeconds(30))
    }
    catch [Threading.AbandonedMutexException] {
        $script:workerMutexHeld = $true
    }
    if (-not $script:workerMutexHeld) {
        throw 'Timed out waiting for the PowerPoint worker mutex.'
    }

    if (
        (Test-Path -LiteralPath $outputPath) -or
        (Test-Path -LiteralPath $stagingDirectory)
    ) {
        throw 'OutputDirectory or its staging directory appeared before mutation.'
    }
    $baselinePowerPointIdentities = Get-PowerPointProcesses
    if ($baselinePowerPointIdentities.Count -ne 0) {
        throw "PowerPoint worker requires an exclusive automation session with a zero process baseline; observed $($baselinePowerPointIdentities -join ', ')."
    }
    [void](New-Item -ItemType Directory -Path $stagingDirectory)
    $ownsStagingDirectory = $true
    [IO.File]::WriteAllBytes($candidatePath, $skeletonBytes)
    [void](New-Item -ItemType Directory -Path $temporaryRenderPath)

    $powerPoint = New-Object -ComObject PowerPoint.Application
    $applicationActivated = $true
    Invoke-TestFailpoint -Stage 'activation'
    $windowHandle = [IntPtr][int64]$powerPoint.HWND
    if ($windowHandle -eq [IntPtr]::Zero) {
        throw 'PowerPoint automation returned an invalid HWND.'
    }
    [uint32]$resolvedProcessId = 0
    [void][FdePowerPointWorkerNativeMethods]::GetWindowThreadProcessId(
        $windowHandle,
        [ref]$resolvedProcessId
    )
    if ($resolvedProcessId -le 0) {
        throw 'PowerPoint HWND did not resolve to a process ID.'
    }
    Invoke-TestFailpoint -Stage 'hwnd'
    $workerProcessId = [int]$resolvedProcessId
    $ownedPowerPointProcess = Get-Process -Id $workerProcessId -ErrorAction Stop
    $ownedPowerPointProcessHandle = $ownedPowerPointProcess.Handle
    if ($ownedPowerPointProcess.HasExited) {
        throw "PowerPoint HWND process PID $workerProcessId exited before ownership validation."
    }
    if (-not [string]::Equals(
        $ownedPowerPointProcess.ProcessName,
        'POWERPNT',
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "PowerPoint HWND resolved to unexpected process $($ownedPowerPointProcess.ProcessName)."
    }
    $workerProcessPath = $ownedPowerPointProcess.Path
    if (
        [string]::IsNullOrWhiteSpace($workerProcessPath) -or
        -not [string]::Equals(
            [IO.Path]::GetFileName($workerProcessPath),
            'POWERPNT.EXE',
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "PowerPoint HWND process PID $workerProcessId has an unexpected executable path."
    }
    $workerProcessStart = $ownedPowerPointProcess.StartTime
    if ($ownedPowerPointProcess.HasExited) {
        throw "PowerPoint HWND process PID $workerProcessId exited during ownership validation."
    }
    $verifiedWindowHandle = [IntPtr][int64]$powerPoint.HWND
    if ($verifiedWindowHandle -eq [IntPtr]::Zero) {
        throw 'PowerPoint automation returned an invalid HWND during ownership validation.'
    }
    [uint32]$verifiedProcessId = 0
    [void][FdePowerPointWorkerNativeMethods]::GetWindowThreadProcessId(
        $verifiedWindowHandle,
        [ref]$verifiedProcessId
    )
    if ([int]$verifiedProcessId -ne $workerProcessId) {
        throw "PowerPoint HWND process changed during ownership validation from PID $workerProcessId to PID $verifiedProcessId."
    }
    $hasProvisionalPowerPointProcess = $true
    Invoke-TestFailpoint -Stage 'process-acquired'
    $ownsPowerPointProcess = $true
    Invoke-TestFailpoint -Stage 'process-validated'
    Assert-NoPowerPointContamination -OwnedProcessId $workerProcessId -OwnedProcessStart $workerProcessStart

    $presentations = $powerPoint.Presentations
    if (
        $env:FDE_POWERPOINT_TEST_FAILPOINTS -eq '1' -and
        $env:FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN -eq '1'
    ) {
        [IO.File]::AppendAllText($candidatePath, 'test-mutation')
    }
    $candidateSourceSha256 = Get-Sha256 -Path $candidatePath
    if (-not [string]::Equals($candidateSourceSha256, $stagedSkeletonSha256, [StringComparison]::Ordinal)) {
        throw 'Staged skeleton bytes changed before Presentations.Open.'
    }
    $presentation = $presentations.Open($candidatePath, $false, $false, $false)
    $slides = $null
    try {
        $slides = $presentation.Slides
        if ($slides.Count -ne $slidesSpec.Count) {
            throw "Skeleton slide count $($slides.Count) does not match drawing spec count $($slidesSpec.Count)."
        }
        for ($slideIndex = 1; $slideIndex -le $slides.Count; $slideIndex++) {
            $slide = $null
            $shapes = $null
            try {
                $slide = $slides.Item($slideIndex)
                $slideSpec = $slidesSpec[$slideIndex - 1]
                $beforeNotes = Get-NativeNotesText -Slide $slide
                if ((Normalize-NotesText -Text $beforeNotes) -ne (Normalize-NotesText -Text ([string]$slideSpec.notesText))) {
                    throw "Skeleton notes do not match the drawing spec on slide $slideIndex."
                }
                $nativeNotes.Add($beforeNotes)
                Invoke-TestFailpoint -Stage 'notes'

                Set-SlideBackground `
                    -Slide $slide `
                    -Theme $specObject.theme `
                    -Role ([string]$slideSpec.backgroundColorRole)
                $shapes = $slide.Shapes
                Remove-SeedShapes -Shapes $shapes
                Invoke-TestFailpoint -Stage 'delete'

                $primitives = @($slideSpec.primitives)
                for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
                    $primitive = $primitives[$primitiveIndex]
                    try {
                        switch ([string]$primitive.kind) {
                            'text' {
                                Add-TextPrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                Invoke-TestFailpoint -Stage 'text'
                            }
                            'shape' {
                                Add-ShapePrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                Invoke-TestFailpoint -Stage 'shape'
                            }
                            'line' {
                                if (Test-WorkflowConnectorPrimitive -Primitive $primitive) {
                                    Add-WorkflowConnectorPrimitive `
                                        -Shapes $shapes `
                                        -Primitive $primitive `
                                        -Theme $specObject.theme
                                    Invoke-TestFailpoint -Stage 'connector'
                                }
                                else {
                                    Add-LinePrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                    Invoke-TestFailpoint -Stage 'line'
                                }
                            }
                            'table' {
                                Add-TablePrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                Invoke-TestFailpoint -Stage 'table'
                            }
                        }
                    }
                    catch {
                        throw "Slide $slideIndex primitive $($primitive.name) ($($primitive.kind)) failed: $($_.Exception.Message)"
                    }
                }
                Assert-TextFits -Slide $slide -SlideSpec $slideSpec
                Assert-NativeTables -Slide $slide -SlideSpec $slideSpec -Theme $specObject.theme
                Invoke-TestFailpoint -Stage 'overflow'
            }
            finally {
                Release-ComRef -Reference ([ref]$shapes) -Label 'authoring shapes'
                Release-ComRef -Reference ([ref]$slide) -Label 'authoring slide'
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$slides) -Label 'authoring slides'
    }

    $presentation.Save()
    $presentation.Close()
    Release-ComRef -Reference ([ref]$presentation) -Label 'authored presentation'
    Invoke-TestFailpoint -Stage 'save'

    $reopened = $presentations.Open($candidatePath, $true, $false, $false)
    $pageSetup = $null
    $reopenedSlides = $null
    try {
        $pageSetup = $reopened.PageSetup
        if ([single]$pageSetup.SlideWidth -ne 960 -or [single]$pageSetup.SlideHeight -ne 540) {
            throw "Final presentation stage is not 960x540."
        }
        $reopenedSlides = $reopened.Slides
        if ($reopenedSlides.Count -ne $slidesSpec.Count) {
            throw "Final presentation slide count does not match the drawing spec."
        }
        if ($env:FDE_POWERPOINT_TEST_MUTATE_CONNECTOR_BEFORE_VERIFY -eq '1') {
            for ($slideIndex = 1; $slideIndex -le $reopenedSlides.Count; $slideIndex++) {
                $slide = $null
                try {
                    $slide = $reopenedSlides.Item($slideIndex)
                    $slideSpec = $slidesSpec[$slideIndex - 1]
                    if (
                        @(
                            $slideSpec.primitives | Where-Object {
                                Test-WorkflowConnectorPrimitive -Primitive $_
                            }
                        ).Count -gt 0
                    ) {
                        Invoke-WorkflowConnectorMutationHook -Slide $slide -SlideSpec $slideSpec
                        break
                    }
                }
                finally {
                    Release-ComRef -Reference ([ref]$slide) -Label 'connector mutation slide'
                }
            }
        }
        for ($slideIndex = 1; $slideIndex -le $reopenedSlides.Count; $slideIndex++) {
            $slide = $null
            try {
                $slide = $reopenedSlides.Item($slideIndex)
                $slideSpec = $slidesSpec[$slideIndex - 1]
                Assert-SlideBackground `
                    -Slide $slide `
                    -Theme $specObject.theme `
                    -Role ([string]$slideSpec.backgroundColorRole) `
                    -SlideIndex $slideIndex
                $finalNotes = Get-NativeNotesText -Slide $slide
                if (-not [string]::Equals($finalNotes, $nativeNotes[$slideIndex - 1], [StringComparison]::Ordinal)) {
                    throw "Final native notes changed on slide $slideIndex."
                }
                if (-not $tableMutationApplied) {
                    $tableMutationApplied = Invoke-TestTableMutation `
                        -Slide $slide `
                        -SlideSpec $slideSpec
                }
                $actualNames = @(Get-ShapeNames -Slide $slide)
                $expectedNames = [System.Collections.Generic.List[string]]::new()
                for ($primitiveIndex = 0; $primitiveIndex -lt $slideSpec.primitives.Count; $primitiveIndex++) {
                    $expectedNames.Add([string]$slideSpec.primitives[$primitiveIndex].name)
                }
                Assert-ExactShapeNames -Expected $expectedNames.ToArray() -Actual $actualNames -SlideIndex $slideIndex
                $verifiedConnectorCount = Assert-WorkflowConnectors `
                    -Slide $slide `
                    -SlideSpec $slideSpec `
                    -Theme $specObject.theme `
                    -SlideIndex $slideIndex
                $connectorSlideReport = $connectorSlideReportById[[string]$slideSpec.id]
                if ($verifiedConnectorCount -ne [int]$connectorSlideReport.segmentCount) {
                    throw "Reopened connector count changed on slide $slideIndex."
                }
                Assert-TextFits -Slide $slide -SlideSpec $slideSpec
                Assert-NativeTables -Slide $slide -SlideSpec $slideSpec -Theme $specObject.theme
            }
            finally {
                Release-ComRef -Reference ([ref]$slide) -Label 'reopen verification slide'
            }
        }
        Invoke-TestFailpoint -Stage 'reopen'

        for ($slideIndex = 1; $slideIndex -le $reopenedSlides.Count; $slideIndex++) {
            $slide = $null
            try {
                $slide = $reopenedSlides.Item($slideIndex)
                $slideSpec = $slidesSpec[$slideIndex - 1]
                $renderName = 'slide-{0:D3}.png' -f $slideIndex
                $renderFile = Join-Path $temporaryRenderPath $renderName
                $slide.Export($renderFile, 'PNG', 1600, 900)
                Assert-PngDimensions -Path $renderFile
                $shapeNames = @(Get-ShapeNames -Slide $slide)
                $primitiveJson = $slideSpec.primitives | ConvertTo-Json -Depth 30 -Compress
                $nativeTableCount = 0
                $nativeTableCellCount = 0
                for ($primitiveIndex = 0; $primitiveIndex -lt $slideSpec.primitives.Count; $primitiveIndex++) {
                    $reportPrimitive = $slideSpec.primitives[$primitiveIndex]
                    if ([string]$reportPrimitive.kind -eq 'table') {
                        $nativeTableCount++
                        $nativeTableCellCount += (
                            @($reportPrimitive.headers).Count *
                            (@($reportPrimitive.rows).Count + 1)
                        )
                    }
                }
                $connectorSlideReport = $connectorSlideReportById[[string]$slideSpec.id]
                $slideReports.Add([pscustomobject]@{
                    index = $slideIndex
                    id = [string]$slideSpec.id
                    family = [string]$slideSpec.family
                    backgroundColorRole = [string]$slideSpec.backgroundColorRole
                    primitiveCount = $slideSpec.primitives.Count
                    primitiveSha256 = Get-TextSha256 -Text $primitiveJson
                    shapeCount = $shapeNames.Count
                    shapeNamesSha256 = Get-TextSha256 -Text ($shapeNames -join "`n")
                    nativeTableCount = $nativeTableCount
                    nativeTableCellCount = $nativeTableCellCount
                    connectorRouteCount = [int]$connectorSlideReport.routeCount
                    connectorSegmentCount = [int]$connectorSlideReport.segmentCount
                    connectorPrimitiveSha256 = [string]$connectorSlideReport.connectorPrimitiveSha256
                    connectorRouteMetadataSha256 = [string]$connectorSlideReport.routeMetadataSha256
                    connectorPointSequenceSha256 = [string]$connectorSlideReport.pointSequenceSha256
                    connectorCostStatus = [string]$connectorSlideReport.costStatus
                    render = $renderName
                    renderSha256 = Get-Sha256 -Path $renderFile
                    notesSha256 = Get-TextSha256 -Text $nativeNotes[$slideIndex - 1]
                    overflow = $false
                })
                Invoke-TestFailpoint -Stage 'export'
            }
            finally {
                Release-ComRef -Reference ([ref]$slide) -Label 'export slide'
            }
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$reopenedSlides) -Label 'reopened slides'
        Release-ComRef -Reference ([ref]$pageSetup) -Label 'page setup'
    }
    $reopened.Close()
    Release-ComRef -Reference ([ref]$reopened) -Label 'reopened presentation'
    Release-ComRef -Reference ([ref]$presentations) -Label 'presentations collection'

    $renderFiles = [System.Collections.Generic.List[string]]::new()
    for ($slideIndex = 1; $slideIndex -le $slidesSpec.Count; $slideIndex++) {
        $renderFiles.Add((Join-Path $temporaryRenderPath ('slide-{0:D3}.png' -f $slideIndex)))
    }
    $contactSheetPath = Join-Path $temporaryRenderPath 'contact-sheet.png'
    New-ContactSheet -Images $renderFiles.ToArray() -OutputPath $contactSheetPath
    if (-not (Test-Path -LiteralPath $contactSheetPath -PathType Leaf)) {
        throw 'Contact sheet was not created.'
    }
    Assert-NoPowerPointContamination -OwnedProcessId $workerProcessId -OwnedProcessStart $workerProcessStart
}
catch {
    $operationErrorMessage = $_.Exception.Message
}
finally {
    if ($null -ne $reopened) {
        try {
            $reopened.Close()
        }
        catch {
            $script:cleanupErrors.Add("reopened presentation close: $($_.Exception.Message)")
        }
        Release-ComRef -Reference ([ref]$reopened) -Label 'reopened presentation'
    }
    if ($null -ne $presentation) {
        try {
            $presentation.Close()
        }
        catch {
            $script:cleanupErrors.Add("presentation close: $($_.Exception.Message)")
        }
        Release-ComRef -Reference ([ref]$presentation) -Label 'presentation'
    }
    Release-ComRef -Reference ([ref]$presentations) -Label 'presentations collection'

    if ($null -ne $powerPoint -and $applicationActivated) {
        try {
            $powerPoint.Quit()
        }
        catch {
            $script:cleanupErrors.Add("PowerPoint Quit: $($_.Exception.Message)")
        }
    }

    if ($hasProvisionalPowerPointProcess -or $ownsPowerPointProcess) {
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds($powerPointGraceSeconds)
            $ownedPowerPointProcess.Refresh()
            while (
                -not $ownedPowerPointProcess.HasExited -and
                [DateTimeOffset]::UtcNow -lt $deadline
            ) {
                Start-Sleep -Milliseconds 100
                $ownedPowerPointProcess.Refresh()
            }
            if ($ownedPowerPointProcess.HasExited) {
                $powerPointCleanupMode = 'graceful'
            }
            else {
                if (
                    $ownedPowerPointProcess.Id -ne $workerProcessId -or
                    $ownedPowerPointProcess.Handle -ne $ownedPowerPointProcessHandle
                ) {
                    throw "Retained PowerPoint process handle changed before cleanup for PID $workerProcessId."
                }
                if (
                    $ownsPowerPointProcess -and (
                        $ownedPowerPointProcess.StartTime -ne $workerProcessStart -or
                        -not [string]::Equals(
                            $ownedPowerPointProcess.Path,
                            $workerProcessPath,
                            [StringComparison]::OrdinalIgnoreCase
                        )
                    )
                ) {
                    throw "Validated PowerPoint process identity changed before cleanup for PID $workerProcessId."
                }
                try {
                    $ownedPowerPointProcess.Kill()
                }
                catch {
                    $ownedPowerPointProcess.Refresh()
                    if (-not $ownedPowerPointProcess.HasExited) {
                        throw
                    }
                    $powerPointCleanupMode = 'graceful'
                }
                if ($null -eq $powerPointCleanupMode) {
                    if (-not $ownedPowerPointProcess.WaitForExit(5000)) {
                        throw "PowerPoint process PID $workerProcessId survived forced cleanup."
                    }
                    $powerPointCleanupMode = 'forced'
                }
            }
        }
        catch {
            $cleanupErrorMessage = $_.Exception.Message
        }
    }
    if ($null -ne $ownedPowerPointProcess) {
        $ownedPowerPointProcess.Dispose()
        $ownedPowerPointProcess = $null
        $ownedPowerPointProcessHandle = [IntPtr]::Zero
    }
    if ($null -eq $cleanupErrorMessage -and $script:workerMutexHeld) {
        try {
            Assert-PowerPointBaselineRestored
        }
        catch {
            $cleanupErrorMessage = $_.Exception.Message
        }
    }
    if ($script:cleanupErrors.Count -gt 0 -and $null -eq $cleanupErrorMessage) {
        $cleanupErrorMessage = $script:cleanupErrors -join '; '
    }
}

if ($null -ne $operationErrorMessage -or $null -ne $cleanupErrorMessage) {
    if ($ownsStagingDirectory) {
        Remove-StagedPath -Path $stagingDirectory
        $ownsStagingDirectory = $false
    }
    Release-WorkerMutex
    $cleanupReceipt = if (
        $hasProvisionalPowerPointProcess -and
        $null -ne $workerProcessStart -and
        $null -ne $powerPointCleanupMode
    ) {
        " PowerPoint cleanup: PID $workerProcessId start $($workerProcessStart.ToUniversalTime().ToString('o')) exited via $powerPointCleanupMode."
    }
    else {
        ''
    }
    $message = if ($null -ne $cleanupErrorMessage) {
        if ($null -ne $operationErrorMessage) {
            "$operationErrorMessage Cleanup failed: $cleanupErrorMessage"
        }
        else {
            "Cleanup failed: $cleanupErrorMessage"
        }
    }
    else {
        $operationErrorMessage
    }
    [Console]::Error.WriteLine("PowerPoint worker failed: $message$cleanupReceipt")
    [Console]::Error.Flush()
    [GC]::KeepAlive($powerPoint)
    [Environment]::Exit(1)
}

try {
    $cleanupReceiptObject = [pscustomobject]@{
        ownedProcessId = $workerProcessId
        ownedProcessStartUtc = $workerProcessStart.ToUniversalTime().ToString('o')
        ownedProcessPath = $workerProcessPath
        exited = $true
        mode = $powerPointCleanupMode
        graceSeconds = $powerPointGraceSeconds
        contaminationDetected = $false
        releaseErrors = @()
    }
    $elapsedMilliseconds = [math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds)
    $contactSheetTemporaryPath = Join-Path $temporaryRenderPath 'contact-sheet.png'
    $finalPresentationSha256 = Get-Sha256 -Path $candidatePath
    $finalPresentationPath = Join-Path $outputPath 'readout.pptx'
    $finalRenderPath = Join-Path $outputPath 'native-render'
    $finalReportPath = Join-Path $outputPath 'worker-report.json'
    $reportObject = [ordered]@{
        status = 'WORKER_PASS'
        stagingEvidence = $true
        worker = 'fde-powerpoint-tables-connectors/1.0'
        spec = $specPath
        specSha256 = $actualSpecSha256
        skeleton = $skeletonPath
        skeletonSha256 = $stagedSkeletonSha256
        presentation = $finalPresentationPath
        presentationSha256 = $finalPresentationSha256
        renderDirectory = $finalRenderPath
        report = $finalReportPath
        contactSheet = Join-Path $finalRenderPath 'contact-sheet.png'
        contactSheetSha256 = Get-Sha256 -Path $contactSheetTemporaryPath
        selectedSlideIds = $selectedSlideIds
        selectedSlideFamilies = $selectedSlideFamilies
        connectors = [ordered]@{
            drawingNameCount = [int]$connectorSpecReport.drawingNameCount
            slideCount = [int]$connectorSpecReport.slideCount
            routeCount = [int]$connectorSpecReport.routeCount
            segmentCount = [int]$connectorSpecReport.segmentCount
            primitiveSha256 = [string]$connectorSpecReport.connectorPrimitiveSha256
            routeMetadataSha256 = [string]$connectorSpecReport.routeMetadataSha256
            pointSequenceSha256 = [string]$connectorSpecReport.pointSequenceSha256
            costStatus = [string]$connectorSpecReport.costStatus
            reopenedExactVerification = $true
            slides = @($connectorSpecReport.slides)
        }
        slides = $slideReports.ToArray()
        cleanup = $cleanupReceiptObject
        elapsedMilliseconds = $elapsedMilliseconds
    }
    $reportJson = $reportObject | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($stagedReportPath, $reportJson, [Text.UTF8Encoding]::new($false))
    Release-WorkerMutex
    if ($script:cleanupErrors.Count -gt 0) {
        throw "Worker mutex cleanup failed: $($script:cleanupErrors -join '; ')"
    }
    Invoke-TestFailpoint -Stage 'publish-bundle'
    if (Test-Path -LiteralPath $outputPath) {
        throw 'OutputDirectory appeared before atomic bundle publication.'
    }
    [IO.Directory]::Move($stagingDirectory, $outputPath)
    $ownsStagingDirectory = $false
}
catch {
    $operationErrorMessage = "Atomic bundle publish failed: $($_.Exception.Message)"
    if ($ownsStagingDirectory) {
        Remove-StagedPath -Path $stagingDirectory
        $ownsStagingDirectory = $false
    }
}
finally {
    Release-WorkerMutex
}

if ($null -ne $operationErrorMessage -or $script:cleanupErrors.Count -gt 0) {
    if ($ownsStagingDirectory) {
        Remove-StagedPath -Path $stagingDirectory
        $ownsStagingDirectory = $false
    }
    $detail = if ($script:cleanupErrors.Count -gt 0) {
        "$operationErrorMessage Mutex cleanup failed: $($script:cleanupErrors -join '; ')"
    }
    else {
        $operationErrorMessage
    }
    [Console]::Error.WriteLine("PowerPoint worker failed: $detail PowerPoint cleanup: PID $workerProcessId start $($workerProcessStart.ToUniversalTime().ToString('o')) exited via $powerPointCleanupMode.")
    [Console]::Error.Flush()
    [GC]::KeepAlive($powerPoint)
    [Environment]::Exit(1)
}

[Console]::Out.WriteLine(($reportObject | ConvertTo-Json -Depth 12 -Compress))
[Console]::Out.Flush()
[GC]::KeepAlive($powerPoint)
[Environment]::Exit(0)
