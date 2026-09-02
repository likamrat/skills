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
        $line.EndArrowheadStyle = if ($Primitive.arrowEnd -eq 'open') { 3 } else { 1 }
    }
    finally {
        Release-ComRef -Reference ([ref]$lineColor) -Label 'line color'
        Release-ComRef -Reference ([ref]$line) -Label 'line format'
        Release-ComRef -Reference ([ref]$shape) -Label 'line shape'
    }
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
            if ($kind -notin @('text', 'shape', 'line')) {
                throw "Unsupported primitive kind '$kind'. The basic PowerPoint worker supports only text, shape, and line; table, nativeChart, and connector require later layers."
            }
        }
    }
    if ($PSBoundParameters.ContainsKey('FailAfter') -and $env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1') {
        throw 'PowerPoint worker failpoints require FDE_POWERPOINT_TEST_FAILPOINTS=1.'
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
                                Add-LinePrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                Invoke-TestFailpoint -Stage 'line'
                            }
                        }
                    }
                    catch {
                        throw "Slide $slideIndex primitive $($primitive.name) ($($primitive.kind)) failed: $($_.Exception.Message)"
                    }
                }
                Assert-TextFits -Slide $slide -SlideSpec $slideSpec
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
                $actualNames = @(Get-ShapeNames -Slide $slide)
                $expectedNames = [System.Collections.Generic.List[string]]::new()
                for ($primitiveIndex = 0; $primitiveIndex -lt $slideSpec.primitives.Count; $primitiveIndex++) {
                    $expectedNames.Add([string]$slideSpec.primitives[$primitiveIndex].name)
                }
                Assert-ExactShapeNames -Expected $expectedNames.ToArray() -Actual $actualNames -SlideIndex $slideIndex
                Assert-TextFits -Slide $slide -SlideSpec $slideSpec
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
                $slideReports.Add([pscustomobject]@{
                    index = $slideIndex
                    id = [string]$slideSpec.id
                    family = [string]$slideSpec.family
                    backgroundColorRole = [string]$slideSpec.backgroundColorRole
                    primitiveCount = $slideSpec.primitives.Count
                    primitiveSha256 = Get-TextSha256 -Text $primitiveJson
                    shapeCount = $shapeNames.Count
                    shapeNamesSha256 = Get-TextSha256 -Text ($shapeNames -join "`n")
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
        worker = 'fde-powerpoint-basic/1.0'
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
