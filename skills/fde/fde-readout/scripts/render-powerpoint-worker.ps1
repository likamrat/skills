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
        'native-chart',
        'chart-reopen',
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
    [string]$FailAfter,

    [switch]$ValidateSpecOnly
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

function Assert-WorkerExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($null -eq $Value -or $null -eq $Value.PSObject) {
        throw "$Path must be an object."
    }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Expected.Count) {
        throw "$Path has an invalid property count."
    }
    $expectedSet = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        [void]$expectedSet.Add($Expected[$index])
    }
    for ($index = 0; $index -lt $actual.Count; $index++) {
        if (-not $expectedSet.Contains([string]$actual[$index])) {
            throw "$Path has unsupported property '$($actual[$index])'."
        }
    }
}

function Get-WorkerPublicDrawingSpecJson {
    param([Parameter(Mandatory = $true)][string]$SpecJson)

    $validatorPath = Join-Path $PSScriptRoot 'validate-powerpoint-drawing-spec.mjs'
    if (-not (Test-Path -LiteralPath $validatorPath -PathType Leaf)) {
        throw "Public drawing-spec validator is missing: $validatorPath."
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'node'
    $startInfo.Arguments = '"' + $validatorPath.Replace('"', '\"') + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $validatorProcess = [Diagnostics.Process]::new()
    $validatorProcess.StartInfo = $startInfo
    $started = $false
    try {
        $started = $validatorProcess.Start()
        if (-not $started) {
            throw 'Could not start the public drawing-spec validator.'
        }
        $stdoutTask = $validatorProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $validatorProcess.StandardError.ReadToEndAsync()
        $inputBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($SpecJson)
        $validatorProcess.StandardInput.BaseStream.Write(
            $inputBytes,
            0,
            $inputBytes.Length
        )
        $validatorProcess.StandardInput.BaseStream.Close()
        $validatorProcess.WaitForExit()
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        if ($validatorProcess.ExitCode -ne 0) {
            throw "Public drawing-spec validation failed: $($stderr.Trim())"
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            throw 'Public drawing-spec validator emitted no validated snapshot.'
        }
        if (-not [string]::IsNullOrWhiteSpace($stderr)) {
            throw "Public drawing-spec validator emitted unexpected diagnostics: $($stderr.Trim())"
        }
        return $stdout
    }
    finally {
        if ($started -and -not $validatorProcess.HasExited) {
            $validatorProcess.Kill()
            $validatorProcess.WaitForExit()
        }
        $validatorProcess.Dispose()
    }
}

function Restore-WorkerEncodedStrings {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        $Value
    )

    $prefix = '__FDE_UTF16LE_B64__'
    if ($Value -is [string]) {
        if (-not $Value.StartsWith($prefix, [StringComparison]::Ordinal)) {
            throw 'Validated drawing-spec string is missing its transport encoding.'
        }
        $encoded = $Value.Substring($prefix.Length)
        try {
            $bytes = [Convert]::FromBase64String($encoded)
            if ($bytes.Length % 2 -ne 0) {
                throw 'UTF-16LE transport has an odd byte count.'
            }
            $characters = New-Object char[] ($bytes.Length / 2)
            for ($index = 0; $index -lt $characters.Length; $index++) {
                $characters[$index] = [char](
                    [int]$bytes[$index * 2] -bor
                    ([int]$bytes[$index * 2 + 1] -shl 8)
                )
            }
            return ($characters -join '')
        }
        catch {
            throw 'Validated drawing-spec string transport is invalid.'
        }
    }
    if ($Value -is [Array]) {
        for ($index = 0; $index -lt $Value.Count; $index++) {
            $Value[$index] = Restore-WorkerEncodedStrings -Value $Value[$index]
        }
        return ,$Value
    }
    if ($null -ne $Value -and $Value -is [pscustomobject]) {
        foreach ($property in $Value.PSObject.Properties) {
            $property.Value = Restore-WorkerEncodedStrings -Value $property.Value
        }
    }
    return $Value
}

function Get-WorkerFiniteNumber {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($null -eq $Value) {
        throw "$Path must be a finite number."
    }
    $numericTypeCodes = @(
        [TypeCode]::SByte,
        [TypeCode]::Byte,
        [TypeCode]::Int16,
        [TypeCode]::UInt16,
        [TypeCode]::Int32,
        [TypeCode]::UInt32,
        [TypeCode]::Int64,
        [TypeCode]::UInt64,
        [TypeCode]::Single,
        [TypeCode]::Double,
        [TypeCode]::Decimal
    )
    if ([Type]::GetTypeCode($Value.GetType()) -notin $numericTypeCodes) {
        throw "$Path must be a finite number."
    }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Path must be a finite number."
    }
    return $number
}

function Get-WorkerSafeInteger {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (
        $null -ne $Value -and
        [Type]::GetTypeCode($Value.GetType()) -eq [TypeCode]::Decimal
    ) {
        $decimal = [decimal]$Value
        if (
            $decimal -ne [decimal]::Truncate($decimal) -or
            $decimal -lt -9007199254740991 -or
            $decimal -gt 9007199254740991
        ) {
            throw "$Path must be a safe integer."
        }
        return [double]$decimal
    }
    $number = Get-WorkerFiniteNumber -Value $Value -Path $Path
    if (
        $number -ne [math]::Truncate($number) -or
        [math]::Abs($number) -gt 9007199254740991
    ) {
        throw "$Path must be a safe integer."
    }
    return $number
}

function Get-WorkerFiniteSingleNumber {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $number = Get-WorkerFiniteNumber -Value $Value -Path $Path
    $single = [single]$number
    if (
        [single]::IsNaN($single) -or
        [single]::IsInfinity($single) -or
        ($number -ne 0 -and $single -eq 0)
    ) {
        throw "$Path must remain finite when passed to PowerPoint."
    }
    return $number
}

function Test-WorkerGeometryClose {
    param(
        [Parameter(Mandatory = $true)][double]$Left,
        [Parameter(Mandatory = $true)][double]$Right
    )

    return [math]::Abs($Left - $Right) -le 0.001
}

function Test-WorkerNumberClose {
    param(
        [Parameter(Mandatory = $true)][double]$Left,
        [Parameter(Mandatory = $true)][double]$Right
    )

    if ($Left -eq $Right) {
        return $true
    }
    $scale = [math]::Max(
        [double]::Epsilon,
        [math]::Max([math]::Abs($Left), [math]::Abs($Right))
    )
    return [math]::Abs($Left - $Right) -le $scale * 1e-12
}

function Get-WorkerRoundedCoordinate {
    param([Parameter(Mandatory = $true)][double]$Value)

    return [math]::Round($Value, 3, [MidpointRounding]::AwayFromZero)
}

function Assert-WorkerChartText {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "$Path must be nonblank chart text."
    }
    if ($Value -match '[\x00-\x1f\x7f-\x9f]') {
        throw "$Path contains a control character."
    }
}

function Convert-WorkerScientificToFixed {
    param([Parameter(Mandatory = $true)][string]$Text)

    if ($Text -notmatch '^(?<sign>-?)(?<mantissa>\d+(?:\.\d+)?)[Ee](?<exponent>[+-]?\d+)$') {
        return $Text
    }
    $sign = $Matches.sign
    $mantissa = $Matches.mantissa
    $exponent = [int]$Matches.exponent
    $decimalIndex = $mantissa.IndexOf('.')
    if ($decimalIndex -lt 0) {
        $decimalIndex = $mantissa.Length
    }
    $digits = $mantissa.Replace('.', '')
    $decimalPosition = $decimalIndex + $exponent
    if ($decimalPosition -le 0) {
        return "$sign" + '0.' + ('0' * (-$decimalPosition)) + $digits
    }
    if ($decimalPosition -ge $digits.Length) {
        return "$sign" + $digits + ('0' * ($decimalPosition - $digits.Length))
    }
    return "$sign" +
        $digits.Substring(0, $decimalPosition) +
        '.' +
        $digits.Substring($decimalPosition)
}

function Get-WorkerCanonicalNumberLabel {
    param([Parameter(Mandatory = $true)][double]$Value)

    if ($Value -eq 0) {
        return '0'
    }
    $roundTrip = $null
    for ($precision = 1; $precision -le 17; $precision++) {
        $candidate = $Value.ToString(
            "G$precision",
            [Globalization.CultureInfo]::InvariantCulture
        )
        $parsed = 0.0
        $matched = [double]::TryParse(
            $candidate,
            [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsed
        )
        if ($matched -and $parsed -eq $Value) {
            $roundTrip = $candidate
            break
        }
    }
    if ($null -eq $roundTrip) {
        throw "Could not find a round-trip numeric label for '$Value'."
    }
    $absolute = [math]::Abs($Value)
    if ($absolute -ge 1e21 -or $absolute -lt 1e-6) {
        if ($roundTrip -notmatch '^(?<mantissa>[^Ee]+)[Ee](?<exponent>[+-]?\d+)$') {
            throw "Could not canonicalize numeric label '$roundTrip'."
        }
        $exponent = [int]$Matches.exponent
        $sign = if ($exponent -ge 0) { '+' } else { '-' }
        return "$($Matches.mantissa)e$sign$([math]::Abs($exponent))"
    }
    return Convert-WorkerScientificToFixed -Text $roundTrip
}

function Test-WorkerNumericLabelMatches {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)]$Value
    )

    [void](Get-WorkerFiniteNumber -Value $Value -Path 'numeric label value')
    $parsed = 0.0
    $matched = [double]::TryParse(
        $Label,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsed
    )
    if (
        -not $matched -or
        [double]::IsNaN($parsed) -or
        [double]::IsInfinity($parsed)
    ) {
        return $false
    }
    # The public Node validator already enforces the label's exact ECMAScript spelling and value.
    return $true
}

function Register-WorkerShapeName {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]
        [Collections.Generic.HashSet[string]]$Names
    )

    if (
        $Value -isnot [string] -or
        $Value.Length -gt 120 -or
        $Value -cnotmatch '^fde-[a-z0-9]+(?:-[a-z0-9]+)*$'
    ) {
        throw "$Path must be an fde-* ASCII lowercase kebab-case name of at most 120 characters."
    }
    if (-not $Names.Add($Value)) {
        throw "$Path duplicates nested shape name '$Value'."
    }
}

function Assert-WorkerColorRole {
    param(
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (
        $Value -isnot [string] -or
        $Value -cnotin @('ink', 'system', 'decision', 'risk', 'paper', 'muted', 'line') -or
        $null -eq $Theme.colors.PSObject.Properties[$Value]
    ) {
        throw "$Path has unknown theme color role '$Value'."
    }
    [void](Convert-HexColor -Hex ([string]$Theme.colors.PSObject.Properties[$Value].Value))
}

function Assert-WorkerBox {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $x = Get-WorkerFiniteSingleNumber -Value $Value.x -Path "$Path.x"
    $y = Get-WorkerFiniteSingleNumber -Value $Value.y -Path "$Path.y"
    $w = Get-WorkerFiniteSingleNumber -Value $Value.w -Path "$Path.w"
    $h = Get-WorkerFiniteSingleNumber -Value $Value.h -Path "$Path.h"
    $singleX = [single]$x
    $singleY = [single]$y
    $singleW = [single]$w
    $singleH = [single]$h
    if (
        $x -lt 0 -or
        $y -lt 0 -or
        $w -le 0 -or
        $h -le 0 -or
        $x + $w -gt 960 -or
        $y + $h -gt 540 -or
        $singleW -le 0 -or
        $singleH -le 0 -or
        $singleX + $singleW -gt 960 -or
        $singleY + $singleH -gt 540
    ) {
        throw "$Path is outside the 960x540 stage."
    }
}

function Test-WorkerBoxWithin {
    param(
        [Parameter(Mandatory = $true)]$Inner,
        [Parameter(Mandatory = $true)]$Outer
    )

    return (
        [double]$Inner.x -ge [double]$Outer.x - 0.001 -and
        [double]$Inner.y -ge [double]$Outer.y - 0.001 -and
        [double]$Inner.x + [double]$Inner.w -le [double]$Outer.x + [double]$Outer.w + 0.001 -and
        [double]$Inner.y + [double]$Inner.h -le [double]$Outer.y + [double]$Outer.h + 0.001
    )
}

function Assert-WorkerChartLabel {
    param(
        [Parameter(Mandatory = $true)]$Label,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]
        [Collections.Generic.HashSet[string]]$Names,
        $Container
    )

    Assert-WorkerExactProperties `
        -Value $Label `
        -Expected @(
            'name',
            'text',
            'x',
            'y',
            'w',
            'h',
            'fontSize',
            'bold',
            'colorRole',
            'horizontalAlign',
            'verticalAlign',
            'rotation'
        ) `
        -Path $Path
    Register-WorkerShapeName -Value $Label.name -Path "$Path.name" -Names $Names
    Assert-WorkerChartText -Value $Label.text -Path "$Path.text"
    Assert-WorkerBox -Value $Label -Path $Path
    if ($null -ne $Container -and -not (Test-WorkerBoxWithin -Inner $Label -Outer $Container)) {
        throw "$Path must remain inside its chart region."
    }
    $fontSize = Get-WorkerFiniteNumber -Value $Label.fontSize -Path "$Path.fontSize"
    $rotation = Get-WorkerFiniteNumber -Value $Label.rotation -Path "$Path.rotation"
    if ($fontSize -ne 8 -or $Label.bold -isnot [bool]) {
        throw "$Path must use 8-point text and a boolean bold value."
    }
    Assert-WorkerColorRole -Theme $Theme -Value $Label.colorRole -Path "$Path.colorRole"
    if (
        $Label.horizontalAlign -isnot [string] -or
        $Label.horizontalAlign -cnotin @('left', 'center', 'right')
    ) {
        throw "$Path has invalid horizontal alignment."
    }
    if (
        $Label.verticalAlign -isnot [string] -or
        $Label.verticalAlign -cnotin @('top', 'middle', 'bottom')
    ) {
        throw "$Path has invalid vertical alignment."
    }
    if ($rotation -ne 0) {
        throw "$Path chart labels cannot be rotated."
    }
}

function Assert-WorkerChartLine {
    param(
        [Parameter(Mandatory = $true)]$LineSpec,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]
        [Collections.Generic.HashSet[string]]$Names,
        [Parameter(Mandatory = $true)]$Container
    )

    Assert-WorkerExactProperties `
        -Value $LineSpec `
        -Expected @(
            'name',
            'x1',
            'y1',
            'x2',
            'y2',
            'colorRole',
            'width',
            'dash',
            'transparency'
        ) `
        -Path $Path
    Register-WorkerShapeName -Value $LineSpec.name -Path "$Path.name" -Names $Names
    foreach ($key in @('x1', 'y1', 'x2', 'y2')) {
        [void](Get-WorkerFiniteSingleNumber -Value $LineSpec.$key -Path "$Path.$key")
    }
    [void](Get-WorkerFiniteSingleNumber -Value $LineSpec.width -Path "$Path.width")
    [void](Get-WorkerFiniteNumber -Value $LineSpec.transparency -Path "$Path.transparency")
    if (
        [double]$LineSpec.width -le 0 -or
        [double]$LineSpec.transparency -lt 0 -or
        [double]$LineSpec.transparency -gt 1 -or
        (
            [double]$LineSpec.x1 -eq [double]$LineSpec.x2 -and
            [double]$LineSpec.y1 -eq [double]$LineSpec.y2
        ) -or
        (
            [single]$LineSpec.x1 -eq [single]$LineSpec.x2 -and
            [single]$LineSpec.y1 -eq [single]$LineSpec.y2
        )
    ) {
        throw "$Path has invalid line geometry or style."
    }
    $left = [math]::Min([double]$LineSpec.x1, [double]$LineSpec.x2)
    $top = [math]::Min([double]$LineSpec.y1, [double]$LineSpec.y2)
    $right = [math]::Max([double]$LineSpec.x1, [double]$LineSpec.x2)
    $bottom = [math]::Max([double]$LineSpec.y1, [double]$LineSpec.y2)
    if (
        $left -lt [double]$Container.x - 0.001 -or
        $top -lt [double]$Container.y - 0.001 -or
        $right -gt [double]$Container.x + [double]$Container.w + 0.001 -or
        $bottom -gt [double]$Container.y + [double]$Container.h + 0.001
    ) {
        throw "$Path must remain inside its chart region."
    }
    Assert-WorkerColorRole -Theme $Theme -Value $LineSpec.colorRole -Path "$Path.colorRole"
    if (
        $LineSpec.dash -isnot [string] -or
        $LineSpec.dash -cnotin @('solid', 'dash', 'dot', 'dashDot')
    ) {
        throw "$Path has invalid dash style."
    }
}

function Assert-WorkerNonemptyString {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "$Path must be a nonempty string."
    }
}

function Assert-WorkerJsonArray {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Nonempty
    )

    if ($Value -isnot [Array] -or ($Nonempty -and $Value.Count -lt 1)) {
        $qualifier = if ($Nonempty) { 'a nonempty JSON array' } else { 'a JSON array' }
        throw "$Path must be $qualifier."
    }
}

function Assert-WorkerStringArray {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Nonempty
    )

    Assert-WorkerJsonArray -Value $Value -Path $Path -Nonempty:$Nonempty
    for ($index = 0; $index -lt $Value.Count; $index++) {
        if ($Value[$index] -isnot [string] -or $Value[$index].Length -lt 1) {
            throw "$Path[$index] must be a nonempty string."
        }
    }
}

function Assert-WorkerTextPrimitive {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme
    )

    Assert-WorkerExactProperties `
        -Value $Primitive `
        -Expected @(
            'kind',
            'name',
            'role',
            'z',
            'x',
            'y',
            'w',
            'h',
            'text',
            'fontSize',
            'bold',
            'italic',
            'colorRole',
            'horizontalAlign',
            'verticalAlign',
            'rotation',
            'marginLeft',
            'marginRight',
            'marginTop',
            'marginBottom',
            'wordWrap',
            'autoFit',
            'maxLines'
        ) `
        -Path $Path
    if ($Primitive.kind -isnot [string] -or $Primitive.kind -cne 'text') {
        throw "$Path.kind must be exactly 'text'."
    }
    Assert-WorkerBox -Value $Primitive -Path $Path
    Assert-WorkerChartText -Value $Primitive.text -Path "$Path.text"
    $fontSize = Get-WorkerFiniteNumber -Value $Primitive.fontSize -Path "$Path.fontSize"
    if ($fontSize -notin @(8, 11, 28, 34)) {
        throw "$Path.fontSize is unsupported."
    }
    foreach ($key in @('bold', 'italic', 'wordWrap')) {
        if ($Primitive.$key -isnot [bool]) {
            throw "$Path.$key must be a boolean."
        }
    }
    Assert-WorkerColorRole -Theme $Theme -Value $Primitive.colorRole -Path "$Path.colorRole"
    if (
        $Primitive.horizontalAlign -isnot [string] -or
        $Primitive.horizontalAlign -cnotin @('left', 'center', 'right')
    ) {
        throw "$Path.horizontalAlign is invalid."
    }
    if (
        $Primitive.verticalAlign -isnot [string] -or
        $Primitive.verticalAlign -cnotin @('top', 'middle', 'bottom')
    ) {
        throw "$Path.verticalAlign is invalid."
    }
    $rotation = Get-WorkerFiniteNumber -Value $Primitive.rotation -Path "$Path.rotation"
    if ($rotation -notin @(0, 270)) {
        throw "$Path.rotation is invalid."
    }
    foreach ($key in @('marginLeft', 'marginRight', 'marginTop', 'marginBottom')) {
        $margin = Get-WorkerFiniteSingleNumber -Value $Primitive.$key -Path "$Path.$key"
        if ($margin -lt 0) {
            throw "$Path.$key must be nonnegative."
        }
    }
    $maxLines = Get-WorkerSafeInteger -Value $Primitive.maxLines -Path "$Path.maxLines"
    if (
        -not $Primitive.wordWrap -or
        $Primitive.autoFit -isnot [string] -or
        $Primitive.autoFit -cne 'none' -or
        $maxLines -lt 1
    ) {
        throw "$Path has an invalid text wrapping contract."
    }
}

function Assert-WorkerShapePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme
    )

    if (
        $Primitive.kind -isnot [string] -or
        $Primitive.kind -cne 'shape' -or
        $Primitive.role -isnot [string]
    ) {
        throw "$Path must use exact string kind 'shape' and a string role."
    }
    $workflowNode = $Primitive.role.StartsWith(
        'workflow-node-',
        [StringComparison]::Ordinal
    )
    $expected = @(
        'kind',
        'name',
        'role',
        'z',
        'shapeType',
        'x',
        'y',
        'w',
        'h',
        'fillVisible',
        'fillColorRole',
        'fillTransparency',
        'lineVisible',
        'lineColorRole',
        'lineTransparency',
        'lineWidth',
        'lineDash'
    )
    if ($workflowNode) {
        $expected += 'nodeId'
    }
    Assert-WorkerExactProperties -Value $Primitive -Expected $expected -Path $Path
    Assert-WorkerBox -Value $Primitive -Path $Path
    if (
        $Primitive.shapeType -isnot [string] -or
        $Primitive.shapeType -cnotin @('rect', 'roundRect', 'ellipse', 'diamond')
    ) {
        throw "$Path.shapeType is invalid."
    }
    foreach ($key in @('fillVisible', 'lineVisible')) {
        if ($Primitive.$key -isnot [bool]) {
            throw "$Path.$key must be a boolean."
        }
    }
    Assert-WorkerColorRole `
        -Theme $Theme `
        -Value $Primitive.fillColorRole `
        -Path "$Path.fillColorRole"
    Assert-WorkerColorRole `
        -Theme $Theme `
        -Value $Primitive.lineColorRole `
        -Path "$Path.lineColorRole"
    foreach ($key in @('fillTransparency', 'lineTransparency')) {
        $transparency = Get-WorkerFiniteNumber -Value $Primitive.$key -Path "$Path.$key"
        if ($transparency -lt 0 -or $transparency -gt 1) {
            throw "$Path.$key must be between zero and one."
        }
    }
    $lineWidth = Get-WorkerFiniteSingleNumber `
        -Value $Primitive.lineWidth `
        -Path "$Path.lineWidth"
    if ($lineWidth -le 0) {
        throw "$Path.lineWidth must be positive."
    }
    if (
        $Primitive.lineDash -isnot [string] -or
        $Primitive.lineDash -cnotin @('solid', 'dash', 'dot', 'dashDot')
    ) {
        throw "$Path.lineDash is invalid."
    }
    if ($workflowNode) {
        Assert-WorkerNonemptyString -Value $Primitive.nodeId -Path "$Path.nodeId"
        if ($Primitive.role -cnotin @(
            'workflow-node-source',
            'workflow-node-actor',
            'workflow-node-system',
            'workflow-node-decision'
        )) {
            throw "$Path.role is not a supported workflow node role."
        }
        $workflowRole = $Primitive.role.Substring('workflow-node-'.Length)
        $expectedFillRole = switch -CaseSensitive ($workflowRole) {
            'source' { 'paper' }
            'actor' { 'system' }
            'system' { 'ink' }
            'decision' { 'decision' }
        }
        $expectedFillTransparency = switch -CaseSensitive ($workflowRole) {
            'source' { 0.0 }
            'actor' { 0.9 }
            'system' { 0.94 }
            'decision' { 0.9 }
        }
        $expectedLineRole = if ($workflowRole -ceq 'decision') {
            'decision'
        }
        else {
            'system'
        }
        $expectedLineWidth = if ($workflowRole -ceq 'decision') { 1.5 } else { 1.0 }
        if (
            $Primitive.shapeType -cne 'roundRect' -or
            -not $Primitive.fillVisible -or
            -not $Primitive.lineVisible -or
            $Primitive.fillColorRole -cne $expectedFillRole -or
            $Primitive.fillTransparency -ne $expectedFillTransparency -or
            $Primitive.lineColorRole -cne $expectedLineRole -or
            $Primitive.lineTransparency -ne 0 -or
            $Primitive.lineWidth -ne $expectedLineWidth -or
            $Primitive.lineDash -cne 'solid'
        ) {
            throw "$Path style does not match its workflow node role."
        }
    }
}

function Assert-WorkerLinePrimitive {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme
    )

    if (
        $Primitive.kind -isnot [string] -or
        $Primitive.kind -cne 'line' -or
        $Primitive.role -isnot [string]
    ) {
        throw "$Path must use exact string kind 'line' and a string role."
    }
    $workflowEdge = $Primitive.role.StartsWith(
        'workflow-edge-',
        [StringComparison]::Ordinal
    )
    $expected = @(
        'kind',
        'name',
        'role',
        'z',
        'x1',
        'y1',
        'x2',
        'y2',
        'colorRole',
        'transparency',
        'width',
        'dash',
        'arrowStart',
        'arrowEnd'
    )
    if ($workflowEdge) {
        $expected += @('sourceNodeId', 'targetNodeId', 'edgeIndex', 'segmentIndex')
    }
    Assert-WorkerExactProperties -Value $Primitive -Expected $expected -Path $Path
    $coordinates = @{}
    foreach ($key in @('x1', 'y1', 'x2', 'y2')) {
        $coordinates[$key] = Get-WorkerFiniteSingleNumber `
            -Value $Primitive.$key `
            -Path "$Path.$key"
    }
    $width = Get-WorkerFiniteSingleNumber -Value $Primitive.width -Path "$Path.width"
    $transparency = Get-WorkerFiniteNumber `
        -Value $Primitive.transparency `
        -Path "$Path.transparency"
    if (
        $coordinates.x1 -lt 0 -or
        $coordinates.x1 -gt 960 -or
        $coordinates.x2 -lt 0 -or
        $coordinates.x2 -gt 960 -or
        $coordinates.y1 -lt 0 -or
        $coordinates.y1 -gt 540 -or
        $coordinates.y2 -lt 0 -or
        $coordinates.y2 -gt 540 -or
        ($coordinates.x1 -eq $coordinates.x2 -and $coordinates.y1 -eq $coordinates.y2) -or
        (
            [single]$coordinates.x1 -eq [single]$coordinates.x2 -and
            [single]$coordinates.y1 -eq [single]$coordinates.y2
        ) -or
        $width -le 0
    ) {
        throw "$Path must be a nonzero in-bounds line with positive width."
    }
    if ($transparency -lt 0 -or $transparency -gt 1) {
        throw "$Path.transparency must be between zero and one."
    }
    Assert-WorkerColorRole -Theme $Theme -Value $Primitive.colorRole -Path "$Path.colorRole"
    if (
        $Primitive.dash -isnot [string] -or
        $Primitive.dash -cnotin @('solid', 'dash', 'dot', 'dashDot')
    ) {
        throw "$Path.dash is invalid."
    }
    if (
        $Primitive.arrowStart -isnot [string] -or
        $Primitive.arrowStart -cne 'none' -or
        $Primitive.arrowEnd -isnot [string] -or
        $Primitive.arrowEnd -cnotin @('none', 'open')
    ) {
        throw "$Path arrow style is invalid."
    }
    if ($workflowEdge) {
        Assert-WorkerNonemptyString `
            -Value $Primitive.sourceNodeId `
            -Path "$Path.sourceNodeId"
        Assert-WorkerNonemptyString `
            -Value $Primitive.targetNodeId `
            -Path "$Path.targetNodeId"
        $edgeIndex = Get-WorkerSafeInteger `
            -Value $Primitive.edgeIndex `
            -Path "$Path.edgeIndex"
        $segmentIndex = Get-WorkerSafeInteger `
            -Value $Primitive.segmentIndex `
            -Path "$Path.segmentIndex"
        if ($Primitive.role -cnotmatch '^workflow-edge-(system|decision)-(\d{2})$') {
            throw "$Path.role is not a supported workflow edge role."
        }
        $edgeKind = $Matches[1]
        $roleEdgeIndex = $Matches[2]
        if (
            $edgeIndex -lt 1 -or
            $segmentIndex -lt 1 -or
            $edgeIndex.ToString('00', [Globalization.CultureInfo]::InvariantCulture) -cne $roleEdgeIndex -or
            ($coordinates.x1 -eq $coordinates.x2) -eq
                ($coordinates.y1 -eq $coordinates.y2) -or
            $coordinates.x1 -lt 48 -or
            $coordinates.x1 -gt 912 -or
            $coordinates.x2 -lt 48 -or
            $coordinates.x2 -gt 912 -or
            $coordinates.y1 -lt 116 -or
            $coordinates.y1 -gt 478 -or
            $coordinates.y2 -lt 116 -or
            $coordinates.y2 -gt 478
        ) {
            throw "$Path has invalid workflow edge metadata or orthogonal geometry."
        }
        $expectedWidth = if ($edgeKind -ceq 'decision') { 1.5 } else { 1.0 }
        if (
            $Primitive.colorRole -cne $edgeKind -or
            $transparency -ne 0 -or
            $width -ne $expectedWidth -or
            $Primitive.dash -cne 'solid' -or
            $Primitive.arrowStart -cne 'none'
        ) {
            throw "$Path style does not match its workflow edge role."
        }
    }
}

function Test-WorkerWorkflowAnchorMatches {
    param(
        [Parameter(Mandatory = $true)][double]$X,
        [Parameter(Mandatory = $true)][double]$Y,
        [Parameter(Mandatory = $true)]$Box
    )

    return (
        ($X -eq [double]$Box.x -and $Y -eq [double]$Box.y + [double]$Box.h / 2) -or
        ($X -eq [double]$Box.x + [double]$Box.w -and $Y -eq [double]$Box.y + [double]$Box.h / 2) -or
        ($X -eq [double]$Box.x + [double]$Box.w / 2 -and $Y -eq [double]$Box.y) -or
        ($X -eq [double]$Box.x + [double]$Box.w / 2 -and $Y -eq [double]$Box.y + [double]$Box.h)
    )
}

function Test-WorkerWorkflowSegmentCrossesBox {
    param(
        [Parameter(Mandatory = $true)]$Line,
        [Parameter(Mandatory = $true)]$Box
    )

    if ([double]$Line.y1 -eq [double]$Line.y2) {
        return (
            [double]$Line.y1 -gt [double]$Box.y -and
            [double]$Line.y1 -lt [double]$Box.y + [double]$Box.h -and
            [math]::Max(
                [math]::Min([double]$Line.x1, [double]$Line.x2),
                [double]$Box.x
            ) -lt [math]::Min(
                [math]::Max([double]$Line.x1, [double]$Line.x2),
                [double]$Box.x + [double]$Box.w
            )
        )
    }
    return (
        [double]$Line.x1 -gt [double]$Box.x -and
        [double]$Line.x1 -lt [double]$Box.x + [double]$Box.w -and
        [math]::Max(
            [math]::Min([double]$Line.y1, [double]$Line.y2),
            [double]$Box.y
        ) -lt [math]::Min(
            [math]::Max([double]$Line.y1, [double]$Line.y2),
            [double]$Box.y + [double]$Box.h
        )
    )
}

function Assert-WorkerWorkflowSlideContract {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $nodeIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $nodeById = [Collections.Generic.Dictionary[string, object]]::new(
        [StringComparer]::Ordinal
    )
    $nodeZ = [Collections.Generic.List[double]]::new()
    $edgeZ = [Collections.Generic.List[double]]::new()
    $edgeGroups = [Collections.Generic.Dictionary[string, object]]::new(
        [StringComparer]::Ordinal
    )
    for ($primitiveIndex = 0; $primitiveIndex -lt $Slide.primitives.Count; $primitiveIndex++) {
        $primitive = $Slide.primitives[$primitiveIndex]
        $primitivePath = "$Path.primitives[$primitiveIndex]"
        if (
            $primitive.kind -ceq 'shape' -and
            $primitive.role.StartsWith('workflow-node-', [StringComparison]::Ordinal)
        ) {
            if (-not $nodeIds.Add($primitive.nodeId)) {
                throw "$primitivePath.nodeId duplicates workflow node '$($primitive.nodeId)'."
            }
            $nodeById.Add($primitive.nodeId, $primitive)
            $nodeZ.Add((Get-WorkerSafeInteger -Value $primitive.z -Path "$primitivePath.z"))
        }
        elseif (
            $primitive.kind -ceq 'line' -and
            $primitive.role.StartsWith('workflow-edge-', [StringComparison]::Ordinal)
        ) {
            if (-not $edgeGroups.ContainsKey($primitive.role)) {
                $edgeGroups.Add(
                    $primitive.role,
                    [Collections.Generic.List[object]]::new()
                )
            }
            $edgeGroups[$primitive.role].Add($primitive)
            $edgeZ.Add((Get-WorkerSafeInteger -Value $primitive.z -Path "$primitivePath.z"))
        }
    }
    if ($nodeIds.Count -lt 3 -or $nodeIds.Count -gt 8) {
        throw "$Path must contain 3-8 unique workflow nodes."
    }
    if ($edgeGroups.Count -lt 2 -or $edgeGroups.Count -gt 10) {
        throw "$Path must contain 2-10 workflow edge groups."
    }

    $groupRecords = [Collections.Generic.List[object]]::new()
    foreach ($pair in $edgeGroups.GetEnumerator()) {
        $groupRecords.Add([pscustomobject]@{
                role = $pair.Key
                edgeIndex = $pair.Value[0].edgeIndex
                segments = $pair.Value
            })
    }
    $orderedGroups = @($groupRecords | Sort-Object -Property edgeIndex)
    $hasDecisionEdge = $false
    for ($groupIndex = 0; $groupIndex -lt $orderedGroups.Count; $groupIndex++) {
        $group = $orderedGroups[$groupIndex]
        $segments = $group.segments
        if ($group.edgeIndex -ne $groupIndex + 1) {
            throw "$Path workflow edge indexes must be contiguous from one."
        }
        if ($group.role.StartsWith('workflow-edge-decision-', [StringComparison]::Ordinal)) {
            $hasDecisionEdge = $true
        }
        $sourceNodeId = $segments[0].sourceNodeId
        $targetNodeId = $segments[0].targetNodeId
        if (
            -not $nodeIds.Contains($sourceNodeId) -or
            -not $nodeIds.Contains($targetNodeId)
        ) {
            throw "$Path workflow edge '$($group.role)' references an unknown node."
        }
        for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
            $segment = $segments[$segmentIndex]
            $expectedArrowEnd = if ($segmentIndex -eq $segments.Count - 1) {
                'open'
            }
            else {
                'none'
            }
            if (
                $segment.segmentIndex -ne $segmentIndex + 1 -or
                $segment.sourceNodeId -cne $sourceNodeId -or
                $segment.targetNodeId -cne $targetNodeId -or
                $segment.arrowEnd -cne $expectedArrowEnd
            ) {
                throw "$Path workflow edge '$($group.role)' has inconsistent segment metadata or arrowheads."
            }
            if (
                $segmentIndex -gt 0 -and
                (
                    $segments[$segmentIndex - 1].x2 -ne $segment.x1 -or
                    $segments[$segmentIndex - 1].y2 -ne $segment.y1
                )
            ) {
                throw "$Path workflow edge '$($group.role)' segments do not share exact anchors."
            }
            foreach ($node in $nodeById.Values) {
                if (Test-WorkerWorkflowSegmentCrossesBox -Line $segment -Box $node) {
                    throw "$Path workflow edge '$($group.role)' crosses a node interior."
                }
            }
        }
        $firstSegment = $segments[0]
        $lastSegment = $segments[$segments.Count - 1]
        if (
            -not (Test-WorkerWorkflowAnchorMatches `
                    -X ([double]$firstSegment.x1) `
                    -Y ([double]$firstSegment.y1) `
                    -Box $nodeById[$sourceNodeId]) -or
            -not (Test-WorkerWorkflowAnchorMatches `
                    -X ([double]$lastSegment.x2) `
                    -Y ([double]$lastSegment.y2) `
                    -Box $nodeById[$targetNodeId])
        ) {
            throw "$Path workflow edge '$($group.role)' endpoints do not match their declared nodes."
        }
    }
    if (-not $hasDecisionEdge) {
        throw "$Path must contain a decision workflow edge."
    }
    $maximumEdgeZ = ($edgeZ | Measure-Object -Maximum).Maximum
    $minimumNodeZ = ($nodeZ | Measure-Object -Minimum).Minimum
    if ($maximumEdgeZ -ge $minimumNodeZ) {
        throw "$Path workflow edges must remain behind workflow nodes."
    }
}

function Assert-WorkerDrawingSpecMetadata {
    param([Parameter(Mandatory = $true)]$SpecObject)

    Assert-WorkerExactProperties `
        -Value $SpecObject `
        -Expected @(
            'schemaVersion',
            'units',
            'stage',
            'source',
            'theme',
            'selectedSlideIds',
            'selectedSlideFamilies',
            'slides'
        ) `
        -Path '$'
    if (
        $SpecObject.schemaVersion -isnot [string] -or
        $SpecObject.schemaVersion -cne 'fde-drawing-spec/1.0' -or
        $SpecObject.units -isnot [string] -or
        $SpecObject.units -cne 'points'
    ) {
        throw 'Drawing spec must use fde-drawing-spec/1.0 point units.'
    }
    Assert-WorkerExactProperties `
        -Value $SpecObject.stage `
        -Expected @('width', 'height') `
        -Path '$.stage'
    $stageWidth = Get-WorkerSafeInteger `
        -Value $SpecObject.stage.width `
        -Path '$.stage.width'
    $stageHeight = Get-WorkerSafeInteger `
        -Value $SpecObject.stage.height `
        -Path '$.stage.height'
    if ($stageWidth -ne 960 -or $stageHeight -ne 540) {
        throw 'Drawing spec stage must be exactly 960x540.'
    }

    Assert-WorkerExactProperties `
        -Value $SpecObject.source `
        -Expected @('planId', 'planVersion', 'planSha256') `
        -Path '$.source'
    Assert-WorkerNonemptyString -Value $SpecObject.source.planId -Path '$.source.planId'
    if (
        $SpecObject.source.planVersion -isnot [string] -or
        $SpecObject.source.planVersion -cne '1.0' -or
        $SpecObject.source.planSha256 -isnot [string] -or
        $SpecObject.source.planSha256 -cnotmatch '^[a-f0-9]{64}$'
    ) {
        throw '$.source has an invalid plan version or SHA-256.'
    }

    Assert-WorkerExactProperties `
        -Value $SpecObject.theme `
        -Expected @('fontFamily', 'colors', 'requiredFooter', 'unbranded') `
        -Path '$.theme'
    if (
        $SpecObject.theme.fontFamily -isnot [string] -or
        $SpecObject.theme.fontFamily.Length -lt 1 -or
        $SpecObject.theme.fontFamily.Trim() -cne $SpecObject.theme.fontFamily -or
        $SpecObject.theme.fontFamily -match '[\x00-\x1f\x7f-\x9f]'
    ) {
        throw '$.theme.fontFamily must be nonblank, unpadded, and control-free.'
    }
    Assert-WorkerNonemptyString `
        -Value $SpecObject.theme.requiredFooter `
        -Path '$.theme.requiredFooter'
    if ($SpecObject.theme.unbranded -isnot [bool]) {
        throw '$.theme.unbranded must be a boolean.'
    }
    $colorRoles = @('ink', 'system', 'decision', 'risk', 'paper', 'muted', 'line')
    Assert-WorkerExactProperties `
        -Value $SpecObject.theme.colors `
        -Expected $colorRoles `
        -Path '$.theme.colors'
    foreach ($role in $colorRoles) {
        $color = $SpecObject.theme.colors.PSObject.Properties[$role].Value
        if ($color -isnot [string] -or $color -cnotmatch '^#[0-9A-F]{6}$') {
            throw "$.theme.colors.$role must be an uppercase #RRGGBB string."
        }
    }
    Assert-WorkerStringArray `
        -Value $SpecObject.selectedSlideIds `
        -Path '$.selectedSlideIds' `
        -Nonempty
    Assert-WorkerStringArray `
        -Value $SpecObject.selectedSlideFamilies `
        -Path '$.selectedSlideFamilies' `
        -Nonempty
    Assert-WorkerJsonArray -Value $SpecObject.slides -Path '$.slides' -Nonempty
    if (
        $SpecObject.selectedSlideIds.Count -ne $SpecObject.slides.Count -or
        $SpecObject.selectedSlideFamilies.Count -ne $SpecObject.slides.Count
    ) {
        throw 'Drawing spec selected-slide metadata must match its nonempty slides array.'
    }
}

function Assert-WorkerSlideMetadata {
    param(
        [Parameter(Mandatory = $true)]$Slide,
        [Parameter(Mandatory = $true)][string]$Path
    )

    Assert-WorkerExactProperties `
        -Value $Slide `
        -Expected @(
            'sourceIndex',
            'id',
            'family',
            'title',
            'customerSafe',
            'backgroundColorRole',
            'notesText',
            'evidenceIds',
            'judgmentIds',
            'primitives'
        ) `
        -Path $Path
    $sourceIndex = Get-WorkerSafeInteger `
        -Value $Slide.sourceIndex `
        -Path "$Path.sourceIndex"
    if ($sourceIndex -lt 1) {
        throw "$Path.sourceIndex must be a positive safe integer."
    }
    Assert-WorkerNonemptyString -Value $Slide.id -Path "$Path.id"
    Assert-WorkerNonemptyString -Value $Slide.title -Path "$Path.title"
    if (
        $Slide.family -isnot [string] -or
        $Slide.family -cnotin @(
            'cover',
            'decision',
            'profile',
            'metrics',
            'findings',
            'responsibility',
            'risks',
            'timeline',
            'chart',
            'table',
            'workflow',
            'evaluation',
            'evidence'
        )
    ) {
        throw "$Path.family is unsupported."
    }
    if ($Slide.customerSafe -isnot [bool]) {
        throw "$Path.customerSafe must be a boolean."
    }
    if (
        $Slide.backgroundColorRole -isnot [string] -or
        $Slide.backgroundColorRole -cnotin @(
            'ink',
            'system',
            'decision',
            'risk',
            'paper',
            'muted',
            'line'
        )
    ) {
        throw "$Path.backgroundColorRole is invalid."
    }
    Assert-WorkerStringArray -Value $Slide.evidenceIds -Path "$Path.evidenceIds"
    Assert-WorkerStringArray -Value $Slide.judgmentIds -Path "$Path.judgmentIds"
    if (
        $Slide.notesText -isnot [string] -or
        [string]::IsNullOrWhiteSpace($Slide.notesText) -or
        $Slide.notesText -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
    ) {
        throw "$Path.notesText must be nonblank, control-safe text."
    }
    $notesSuffix = "`r`nEvidence: $($Slide.evidenceIds -join ', ')`r`nHuman context: $($Slide.judgmentIds -join ', ')"
    if (-not $Slide.notesText.EndsWith($notesSuffix, [StringComparison]::Ordinal)) {
        throw "$Path.notesText evidence does not match the slide IDs."
    }
    Assert-WorkerJsonArray -Value $Slide.primitives -Path "$Path.primitives" -Nonempty
}

function Get-WorkerChartY {
    param(
        [Parameter(Mandatory = $true)][double]$Value,
        [Parameter(Mandatory = $true)]$Axis,
        [Parameter(Mandatory = $true)]$Plot
    )

    $minimum = [double]$Axis.min
    $maximum = [double]$Axis.max
    $range = $maximum - $minimum
    if ([double]::IsInfinity($range)) {
        $scale = [math]::Max([math]::Abs($minimum), [math]::Abs($maximum))
        $ratio = (
            $maximum / $scale - $Value / $scale
        ) / (
            $maximum / $scale - $minimum / $scale
        )
    }
    else {
        $ratio = ($maximum - $Value) / $range
    }
    return Get-WorkerRoundedCoordinate -Value ([double]$Plot.y + $ratio * [double]$Plot.h)
}

function Get-WorkerCleanNumber {
    param([Parameter(Mandatory = $true)][double]$Value)

    $text = $Value.ToString('G12', [Globalization.CultureInfo]::InvariantCulture)
    $cleaned = [double]::Parse(
        $text,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture
    )
    if ($cleaned -eq 0) {
        return 0.0
    }
    return $cleaned
}

function Get-WorkerNextNiceStep {
    param([Parameter(Mandatory = $true)][double]$Step)

    $power = [math]::Pow(10, [math]::Floor([math]::Log10($Step)))
    $mantissa = Get-WorkerCleanNumber -Value ($Step / $power)
    if ($mantissa -lt 2) {
        return 2 * $power
    }
    if ($mantissa -lt 5) {
        return 5 * $power
    }
    return 10 * $power
}

function Get-WorkerNiceBounds {
    param(
        [Parameter(Mandatory = $true)][double]$DomainMin,
        [Parameter(Mandatory = $true)][double]$DomainMax,
        [Parameter(Mandatory = $true)][double]$Step
    )

    $minimum = [math]::Floor($DomainMin / $Step) * $Step
    $maximum = [math]::Ceiling($DomainMax / $Step) * $Step
    if (-not [double]::IsInfinity($minimum) -and $minimum -gt $DomainMin) {
        $extended = $minimum - $Step
        $minimum = if ([double]::IsInfinity($extended)) { $DomainMin } else { $extended }
    }
    if (-not [double]::IsInfinity($maximum) -and $maximum -lt $DomainMax) {
        $extended = $maximum + $Step
        $maximum = if ([double]::IsInfinity($extended)) { $DomainMax } else { $extended }
    }
    return [pscustomobject]@{
        min = $minimum
        max = $maximum
    }
}

function Get-WorkerNiceAxis {
    param([Parameter(Mandatory = $true)][double[]]$Values)

    $domainMin = 0.0
    $domainMax = 0.0
    for ($index = 0; $index -lt $Values.Count; $index++) {
        $domainMin = [math]::Min($domainMin, $Values[$index])
        $domainMax = [math]::Max($domainMax, $Values[$index])
    }
    $adjustedMax = if ($domainMin -eq $domainMax) {
        if ($domainMin -eq 0) { 1.0 } else { $domainMin + 1.0 }
    }
    else {
        $domainMax
    }
    $rough = ($adjustedMax - $domainMin) / 4
    if ($rough -eq 0) {
        $step = [double]::Epsilon
        $minimum = [math]::Floor($domainMin / $step) * $step
        $maximum = [math]::Ceiling($adjustedMax / $step) * $step
        $count = [math]::Round(($maximum - $minimum) / $step)
        $ticks = [Collections.Generic.List[double]]::new()
        for ($index = 0; $index -le $count; $index++) {
            $ticks.Add((Get-WorkerCleanNumber -Value ($minimum + $index * $step)))
        }
        return [pscustomobject]@{
            min = $minimum
            max = $maximum
            step = $step
            ticks = $ticks.ToArray()
        }
    }

    $power = [math]::Pow(10, [math]::Floor([math]::Log10($rough)))
    $mantissa = $rough / $power
    $niceMantissa = if ($mantissa -le 1) {
        1
    }
    elseif ($mantissa -le 2) {
        2
    }
    elseif ($mantissa -le 5) {
        5
    }
    else {
        10
    }
    $step = $niceMantissa * $power
    $bounds = Get-WorkerNiceBounds -DomainMin $domainMin -DomainMax $adjustedMax -Step $step
    $minimum = [double]$bounds.min
    $maximum = [double]$bounds.max
    while ([math]::Round(($maximum - $minimum) / $step) + 1 -gt 6) {
        $step = Get-WorkerNextNiceStep -Step $step
        $bounds = Get-WorkerNiceBounds -DomainMin $domainMin -DomainMax $adjustedMax -Step $step
        $minimum = [double]$bounds.min
        $maximum = [double]$bounds.max
    }
    if (
        [double]::IsInfinity($minimum) -or
        [double]::IsInfinity($maximum) -or
        [double]::IsInfinity($step) -or
        [double]::IsNaN($minimum) -or
        [double]::IsNaN($maximum) -or
        [double]::IsNaN($step)
    ) {
        $step = [math]::Max([math]::Abs($domainMin), [math]::Abs($adjustedMax))
        $mixed = $domainMin -lt 0 -and $adjustedMax -gt 0
        $minimum = if ($mixed) { -$step } else { $domainMin }
        $maximum = if ($mixed) { $step } else { $adjustedMax }
        $ticks = [Collections.Generic.List[double]]::new()
        foreach ($candidate in @($minimum, 0.0, $maximum)) {
            if (-not $ticks.Contains([double]$candidate)) {
                $ticks.Add([double]$candidate)
            }
        }
        $tickArray = @($ticks.ToArray() | Sort-Object)
        return [pscustomobject]@{
            min = $minimum
            max = $maximum
            step = $step
            ticks = $tickArray
        }
    }

    $minimum = Get-WorkerCleanNumber -Value $minimum
    $maximum = Get-WorkerCleanNumber -Value $maximum
    $step = Get-WorkerCleanNumber -Value $step
    $count = [math]::Round(($maximum - $minimum) / $step)
    $ticks = [Collections.Generic.List[double]]::new()
    for ($index = 0; $index -le $count; $index++) {
        $ticks.Add((Get-WorkerCleanNumber -Value ($minimum + $index * $step)))
    }
    return [pscustomobject]@{
        min = $minimum
        max = $maximum
        step = $step
        ticks = $ticks.ToArray()
    }
}

function Get-NativeChartBoundsShapeName {
    param([Parameter(Mandatory = $true)][string]$ChartName)

    if ($ChartName.EndsWith('-native-chart', [StringComparison]::Ordinal)) {
        return $ChartName.Substring(0, $ChartName.Length - 13) + '-chart-bounds'
    }
    $digest = Get-TextSha256 -Text $ChartName
    return "fde-chart-bounds-$($digest.Substring(0, 16))"
}

function Assert-NativeChartSpec {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]
        [Collections.Generic.HashSet[string]]$Names,
        [Parameter(Mandatory = $true)][string]$SlideFamily,
        [Parameter(Mandatory = $true)][string[]]$SlideEvidenceIds
    )

    Assert-WorkerExactProperties `
        -Value $Primitive `
        -Expected @(
            'kind',
            'name',
            'role',
            'z',
            'chartType',
            'x',
            'y',
            'w',
            'h',
            'unit',
            'insightEvidenceIds',
            'unitLabel',
            'plot',
            'axis',
            'categories',
            'legend',
            'dataGrid',
            'series'
        ) `
        -Path $Path
    if (
        $SlideFamily -cne 'chart' -or
        $Primitive.role -isnot [string] -or
        $Primitive.role -cne 'native-chart' -or
        $Primitive.kind -isnot [string] -or
        $Primitive.kind -cne 'nativeChart'
    ) {
        throw "$Path is not a chart-family nativeChart primitive."
    }
    Assert-WorkerBox -Value $Primitive -Path $Path
    if (
        [double]$Primitive.x -ne 48 -or
        [double]$Primitive.y -ne 120 -or
        [double]$Primitive.w -ne 864 -or
        [double]$Primitive.h -ne 318
    ) {
        throw "$Path must use the exact 48,120,864,318 chart bounds."
    }
    if (
        $Primitive.chartType -isnot [string] -or
        $Primitive.chartType -cnotin @('bar', 'line')
    ) {
        throw "$Path.chartType must be bar or line."
    }
    Assert-WorkerChartText -Value $Primitive.unit -Path "$Path.unit"

    $declaredEvidence = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    for ($index = 0; $index -lt $SlideEvidenceIds.Count; $index++) {
        [void]$declaredEvidence.Add($SlideEvidenceIds[$index])
    }
    Assert-WorkerJsonArray `
        -Value $Primitive.insightEvidenceIds `
        -Path "$Path.insightEvidenceIds" `
        -Nonempty
    $insightEvidenceIds = $Primitive.insightEvidenceIds
    $seenEvidence = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    for ($index = 0; $index -lt $insightEvidenceIds.Count; $index++) {
        $evidenceId = $insightEvidenceIds[$index]
        Assert-WorkerChartText -Value $evidenceId -Path "$Path.insightEvidenceIds[$index]"
        if (-not $seenEvidence.Add([string]$evidenceId)) {
            throw "$Path.insightEvidenceIds contains a duplicate."
        }
        if (-not $declaredEvidence.Contains([string]$evidenceId)) {
            throw "$Path.insightEvidenceIds[$index] is not declared by the slide."
        }
    }

    $chartBounds = [pscustomobject]@{
        x = [double]$Primitive.x
        y = [double]$Primitive.y
        w = [double]$Primitive.w
        h = [double]$Primitive.h
    }
    Assert-WorkerChartLabel `
        -Label $Primitive.unitLabel `
        -Path "$Path.unitLabel" `
        -Theme $Theme `
        -Names $Names `
        -Container $chartBounds
    if (
        [string]$Primitive.unitLabel.text -cne [string]$Primitive.unit -or
        [double]$Primitive.unitLabel.x -ne 48 -or
        [double]$Primitive.unitLabel.y -ne 142 -or
        [double]$Primitive.unitLabel.w -ne 864 -or
        [double]$Primitive.unitLabel.h -ne 14
    ) {
        throw "$Path.unitLabel does not match the exact unit-label contract."
    }

    Assert-WorkerExactProperties `
        -Value $Primitive.plot `
        -Expected @('x', 'y', 'w', 'h') `
        -Path "$Path.plot"
    Assert-WorkerBox -Value $Primitive.plot -Path "$Path.plot"
    if (
        [double]$Primitive.plot.x -ne 112 -or
        [double]$Primitive.plot.y -ne 160 -or
        [double]$Primitive.plot.w -ne 800 -or
        [double]$Primitive.plot.h -ne 180 -or
        -not (Test-WorkerBoxWithin -Inner $Primitive.plot -Outer $chartBounds)
    ) {
        throw "$Path.plot does not match the exact plot contract."
    }

    Assert-WorkerJsonArray `
        -Value $Primitive.categories `
        -Path "$Path.categories" `
        -Nonempty
    $categories = $Primitive.categories
    if ($categories.Count -lt 2 -or $categories.Count -gt 12) {
        throw "$Path.categories must contain 2-12 entries."
    }
    $categoryWidth = [double]$Primitive.plot.w / $categories.Count
    for ($categoryIndex = 0; $categoryIndex -lt $categories.Count; $categoryIndex++) {
        $category = $categories[$categoryIndex]
        $categoryPath = "$Path.categories[$categoryIndex]"
        Assert-WorkerExactProperties `
            -Value $category `
            -Expected @('index', 'label', 'labelBox') `
            -Path $categoryPath
        $categorySpecIndex = Get-WorkerSafeInteger `
            -Value $category.index `
            -Path "$categoryPath.index"
        if ($categorySpecIndex -ne $categoryIndex) {
            throw "$categoryPath.index must be contiguous."
        }
        Assert-WorkerChartText -Value $category.label -Path "$categoryPath.label"
        Assert-WorkerChartLabel `
            -Label $category.labelBox `
            -Path "$categoryPath.labelBox" `
            -Theme $Theme `
            -Names $Names `
            -Container $chartBounds
        if (
            [string]$category.labelBox.text -cne [string]$category.label -or
            -not (Test-WorkerGeometryClose -Left ([double]$category.labelBox.x) -Right ([double]$Primitive.plot.x + $categoryIndex * $categoryWidth)) -or
            [double]$category.labelBox.y -ne 344 -or
            -not (Test-WorkerGeometryClose -Left ([double]$category.labelBox.w) -Right $categoryWidth) -or
            [double]$category.labelBox.h -ne 28
        ) {
            throw "$categoryPath.labelBox has invalid category-label geometry."
        }
    }

    Assert-WorkerJsonArray `
        -Value $Primitive.series `
        -Path "$Path.series" `
        -Nonempty
    $seriesItems = $Primitive.series
    if ($seriesItems.Count -lt 1 -or $seriesItems.Count -gt 4) {
        throw "$Path.series must contain 1-4 entries."
    }
    $expectedColorRoles = @('system', 'decision', 'ink', 'muted')
    $expectedDashes = @('solid', 'dash', 'dot', 'dashDot')
    $allValues = [Collections.Generic.List[double]]::new()
    for ($seriesIndex = 0; $seriesIndex -lt $seriesItems.Count; $seriesIndex++) {
        $series = $seriesItems[$seriesIndex]
        $seriesPath = "$Path.series[$seriesIndex]"
        $expectedKeys = if ($Primitive.chartType -ceq 'bar') {
            @('index', 'name', 'evidenceIds', 'colorRole', 'dash', 'bars')
        }
        else {
            @('index', 'name', 'evidenceIds', 'colorRole', 'dash', 'segments', 'markers')
        }
        Assert-WorkerExactProperties -Value $series -Expected $expectedKeys -Path $seriesPath
        $seriesSpecIndex = Get-WorkerSafeInteger `
            -Value $series.index `
            -Path "$seriesPath.index"
        if (
            $seriesSpecIndex -ne $seriesIndex -or
            $series.colorRole -isnot [string] -or
            $series.colorRole -cne $expectedColorRoles[$seriesIndex] -or
            $series.dash -isnot [string] -or
            $series.dash -cne $expectedDashes[$seriesIndex]
        ) {
            throw "$seriesPath index or stable style is invalid."
        }
        Assert-WorkerChartText -Value $series.name -Path "$seriesPath.name"
        Assert-WorkerColorRole -Theme $Theme -Value $series.colorRole -Path "$seriesPath.colorRole"
        Assert-WorkerJsonArray `
            -Value $series.evidenceIds `
            -Path "$seriesPath.evidenceIds" `
            -Nonempty
        $seriesEvidenceIds = $series.evidenceIds
        $seenSeriesEvidence = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal
        )
        for ($evidenceIndex = 0; $evidenceIndex -lt $seriesEvidenceIds.Count; $evidenceIndex++) {
            $evidenceId = $seriesEvidenceIds[$evidenceIndex]
            Assert-WorkerChartText -Value $evidenceId -Path "$seriesPath.evidenceIds[$evidenceIndex]"
            if (
                -not $seenSeriesEvidence.Add([string]$evidenceId) -or
                -not $declaredEvidence.Contains([string]$evidenceId)
            ) {
                throw "$seriesPath.evidenceIds is duplicate or undeclared."
            }
        }
        $marks = if ($Primitive.chartType -ceq 'bar') {
            Assert-WorkerJsonArray `
                -Value $series.bars `
                -Path "$seriesPath.bars" `
                -Nonempty
            $series.bars
        }
        else {
            Assert-WorkerJsonArray `
                -Value $series.markers `
                -Path "$seriesPath.markers" `
                -Nonempty
            $series.markers
        }
        if ($marks.Count -ne $categories.Count) {
            throw "$seriesPath mark count must match categories."
        }
        for ($categoryIndex = 0; $categoryIndex -lt $marks.Count; $categoryIndex++) {
            $mark = $marks[$categoryIndex]
            $value = Get-WorkerFiniteNumber -Value $mark.value -Path "$seriesPath.mark[$categoryIndex].value"
            $markCategoryIndex = Get-WorkerSafeInteger `
                -Value $mark.categoryIndex `
                -Path "$seriesPath.mark[$categoryIndex].categoryIndex"
            if ($markCategoryIndex -ne $categoryIndex) {
                throw "$seriesPath mark indexes must be contiguous."
            }
            $allValues.Add($value)
        }
    }

    Assert-WorkerExactProperties `
        -Value $Primitive.axis `
        -Expected @('min', 'max', 'step', 'zeroY', 'baseline', 'ticks') `
        -Path "$Path.axis"
    foreach ($key in @('min', 'max', 'step', 'zeroY')) {
        [void](Get-WorkerFiniteNumber -Value $Primitive.axis.$key -Path "$Path.axis.$key")
    }
    if (
        [double]$Primitive.axis.min -gt 0 -or
        [double]$Primitive.axis.max -lt 0 -or
        [double]$Primitive.axis.min -ge [double]$Primitive.axis.max -or
        [double]$Primitive.axis.step -le 0
    ) {
        throw "$Path.axis must be a finite zero-inclusive increasing domain."
    }
    for ($index = 0; $index -lt $allValues.Count; $index++) {
        if (
            $allValues[$index] -lt [double]$Primitive.axis.min -or
            $allValues[$index] -gt [double]$Primitive.axis.max
        ) {
            throw "$Path.axis does not contain chart value $index."
        }
    }
    $expectedAxis = Get-WorkerNiceAxis -Values $allValues.ToArray()
    if (
        [double]$Primitive.axis.min -ne [double]$expectedAxis.min -or
        [double]$Primitive.axis.max -ne [double]$expectedAxis.max -or
        [double]$Primitive.axis.step -ne [double]$expectedAxis.step
    ) {
        throw "$Path.axis is not the deterministic nice axis derived from chart data."
    }
    $expectedZeroY = Get-WorkerChartY -Value 0 -Axis $Primitive.axis -Plot $Primitive.plot
    if (-not (Test-WorkerGeometryClose -Left ([double]$Primitive.axis.zeroY) -Right $expectedZeroY)) {
        throw "$Path.axis.zeroY does not represent zero."
    }
    Assert-WorkerChartLine `
        -LineSpec $Primitive.axis.baseline `
        -Path "$Path.axis.baseline" `
        -Theme $Theme `
        -Names $Names `
        -Container $Primitive.plot
    if (
        [double]$Primitive.axis.baseline.x1 -ne [double]$Primitive.plot.x -or
        [double]$Primitive.axis.baseline.x2 -ne [double]$Primitive.plot.x + [double]$Primitive.plot.w -or
        -not (Test-WorkerGeometryClose -Left ([double]$Primitive.axis.baseline.y1) -Right ([double]$Primitive.axis.zeroY)) -or
        -not (Test-WorkerGeometryClose -Left ([double]$Primitive.axis.baseline.y2) -Right ([double]$Primitive.axis.zeroY)) -or
        $Primitive.axis.baseline.colorRole -cne 'ink' -or
        [double]$Primitive.axis.baseline.width -ne 1 -or
        $Primitive.axis.baseline.dash -cne 'solid' -or
        [double]$Primitive.axis.baseline.transparency -ne 0
    ) {
        throw "$Path.axis.baseline does not match the zero baseline."
    }

    Assert-WorkerJsonArray `
        -Value $Primitive.axis.ticks `
        -Path "$Path.axis.ticks" `
        -Nonempty
    $ticks = $Primitive.axis.ticks
    if ($ticks.Count -lt 2 -or $ticks.Count -gt 6) {
        throw "$Path.axis.ticks must contain 2-6 entries."
    }
    for ($tickIndex = 0; $tickIndex -lt $ticks.Count; $tickIndex++) {
        $tick = $ticks[$tickIndex]
        $tickPath = "$Path.axis.ticks[$tickIndex]"
        Assert-WorkerExactProperties `
            -Value $tick `
            -Expected @('value', 'label', 'gridLine', 'labelBox') `
            -Path $tickPath
        $tickValue = Get-WorkerFiniteNumber -Value $tick.value -Path "$tickPath.value"
        Assert-WorkerChartText -Value $tick.label -Path "$tickPath.label"
        if (-not (Test-WorkerNumericLabelMatches -Label ([string]$tick.label) -Value $tick.value)) {
            $canonicalLabel = Get-WorkerCanonicalNumberLabel -Value $tickValue
            throw "$tickPath.label is not the canonical numeric label for $tickValue; expected '$canonicalLabel', found '$($tick.label)'."
        }
        if (
            ($tickIndex -eq 0 -and $tickValue -ne [double]$Primitive.axis.max) -or
            ($tickIndex -eq $ticks.Count - 1 -and $tickValue -ne [double]$Primitive.axis.min)
        ) {
            throw "$tickPath must span the declared axis domain: found $tickValue in range $($Primitive.axis.min)..$($Primitive.axis.max)."
        }
        if ($tickIndex -gt 0) {
            $previousValue = [double]$ticks[$tickIndex - 1].value
            $normalizedDifference = (
                $previousValue / [double]$Primitive.axis.step
            ) - (
                $tickValue / [double]$Primitive.axis.step
            )
            if (-not (Test-WorkerNumberClose -Left $normalizedDifference -Right 1)) {
                throw "$tickPath does not follow the declared axis step."
            }
        }
        Assert-WorkerChartLine `
            -LineSpec $tick.gridLine `
            -Path "$tickPath.gridLine" `
            -Theme $Theme `
            -Names $Names `
            -Container $Primitive.plot
        Assert-WorkerChartLabel `
            -Label $tick.labelBox `
            -Path "$tickPath.labelBox" `
            -Theme $Theme `
            -Names $Names `
            -Container $chartBounds
        $expectedY = Get-WorkerChartY -Value $tickValue -Axis $Primitive.axis -Plot $Primitive.plot
        $expectedLabelY = Get-WorkerRoundedCoordinate -Value (
            [math]::Max(
                [double]$Primitive.plot.y,
                [math]::Min(
                    [double]$Primitive.plot.y + [double]$Primitive.plot.h - 12,
                    $expectedY - 6
                )
            )
        )
        if (
            [string]$tick.labelBox.text -cne [string]$tick.label -or
            [double]$tick.gridLine.x1 -ne [double]$Primitive.plot.x -or
            [double]$tick.gridLine.x2 -ne [double]$Primitive.plot.x + [double]$Primitive.plot.w -or
            -not (Test-WorkerGeometryClose -Left ([double]$tick.gridLine.y1) -Right $expectedY) -or
            -not (Test-WorkerGeometryClose -Left ([double]$tick.gridLine.y2) -Right $expectedY) -or
            $tick.gridLine.colorRole -cne 'line' -or
            [double]$tick.gridLine.width -ne 0.75 -or
            $tick.gridLine.dash -cne 'solid' -or
            [double]$tick.gridLine.transparency -ne 0.35 -or
            [double]$tick.labelBox.x -ne 48 -or
            -not (Test-WorkerGeometryClose -Left ([double]$tick.labelBox.y) -Right $expectedLabelY) -or
            [double]$tick.labelBox.w -ne 56 -or
            [double]$tick.labelBox.h -ne 12
        ) {
            throw "$tickPath has inconsistent grid or label geometry."
        }
    }

    Assert-WorkerJsonArray `
        -Value $Primitive.legend `
        -Path "$Path.legend" `
        -Nonempty
    $legend = $Primitive.legend
    if ($legend.Count -ne $seriesItems.Count) {
        throw "$Path.legend must match series."
    }
    $legendWidth = [double]$Primitive.w / $seriesItems.Count
    for ($legendIndex = 0; $legendIndex -lt $legend.Count; $legendIndex++) {
        $entry = $legend[$legendIndex]
        $entryPath = "$Path.legend[$legendIndex]"
        Assert-WorkerExactProperties `
            -Value $entry `
            -Expected @('seriesIndex', 'colorRole', 'swatchName', 'swatch', 'labelBox') `
            -Path $entryPath
        Register-WorkerShapeName -Value $entry.swatchName -Path "$entryPath.swatchName" -Names $Names
        Assert-WorkerExactProperties `
            -Value $entry.swatch `
            -Expected @('x', 'y', 'w', 'h') `
            -Path "$entryPath.swatch"
        Assert-WorkerBox -Value $entry.swatch -Path "$entryPath.swatch"
        Assert-WorkerChartLabel `
            -Label $entry.labelBox `
            -Path "$entryPath.labelBox" `
            -Theme $Theme `
            -Names $Names `
            -Container $chartBounds
        $entrySeriesIndex = Get-WorkerSafeInteger `
            -Value $entry.seriesIndex `
            -Path "$entryPath.seriesIndex"
        Assert-WorkerColorRole `
            -Theme $Theme `
            -Value $entry.colorRole `
            -Path "$entryPath.colorRole"
        if (
            $entrySeriesIndex -ne $legendIndex -or
            $entry.colorRole -cne $seriesItems[$legendIndex].colorRole -or
            -not (Test-WorkerBoxWithin -Inner $entry.swatch -Outer $chartBounds) -or
            -not (Test-WorkerGeometryClose -Left ([double]$entry.swatch.x) -Right (48 + $legendIndex * $legendWidth + 8)) -or
            [double]$entry.swatch.y -ne 128 -or
            [double]$entry.swatch.w -ne 16 -or
            [double]$entry.swatch.h -ne 4 -or
            [string]$entry.labelBox.text -cne [string]$seriesItems[$legendIndex].name -or
            -not (Test-WorkerGeometryClose -Left ([double]$entry.labelBox.x) -Right (48 + $legendIndex * $legendWidth + 30)) -or
            [double]$entry.labelBox.y -ne 120 -or
            -not (Test-WorkerGeometryClose -Left ([double]$entry.labelBox.w) -Right ($legendWidth - 38)) -or
            [double]$entry.labelBox.h -ne 20
        ) {
            throw "$entryPath does not match its series or fixed geometry."
        }
    }

    Assert-WorkerExactProperties `
        -Value $Primitive.dataGrid `
        -Expected @('x', 'y', 'w', 'h', 'seriesLabelWidth', 'rowHeight', 'rows') `
        -Path "$Path.dataGrid"
    Assert-WorkerBox -Value $Primitive.dataGrid -Path "$Path.dataGrid"
    $dataGridSeriesLabelWidth = Get-WorkerFiniteNumber `
        -Value $Primitive.dataGrid.seriesLabelWidth `
        -Path "$Path.dataGrid.seriesLabelWidth"
    $dataGridRowHeight = Get-WorkerFiniteNumber `
        -Value $Primitive.dataGrid.rowHeight `
        -Path "$Path.dataGrid.rowHeight"
    $expectedRowHeight = Get-WorkerRoundedCoordinate -Value (60 / $seriesItems.Count)
    Assert-WorkerJsonArray `
        -Value $Primitive.dataGrid.rows `
        -Path "$Path.dataGrid.rows" `
        -Nonempty
    $rows = $Primitive.dataGrid.rows
    if (
        [double]$Primitive.dataGrid.x -ne 48 -or
        [double]$Primitive.dataGrid.y -ne 376 -or
        [double]$Primitive.dataGrid.w -ne 864 -or
        [double]$Primitive.dataGrid.h -ne 60 -or
        $dataGridSeriesLabelWidth -ne 64 -or
        -not (Test-WorkerGeometryClose -Left $dataGridRowHeight -Right $expectedRowHeight) -or
        $rows.Count -ne $seriesItems.Count -or
        -not (Test-WorkerBoxWithin -Inner $Primitive.dataGrid -Outer $chartBounds)
    ) {
        throw "$Path.dataGrid does not match the fixed data-grid contract."
    }
    $expectedValueWidth = 800 / $categories.Count
    for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
        $row = $rows[$rowIndex]
        $rowPath = "$Path.dataGrid.rows[$rowIndex]"
        Assert-WorkerExactProperties `
            -Value $row `
            -Expected @('seriesIndex', 'labelBox', 'values') `
            -Path $rowPath
        Assert-WorkerJsonArray `
            -Value $row.values `
            -Path "$rowPath.values" `
            -Nonempty
        $values = $row.values
        $rowSeriesIndex = Get-WorkerSafeInteger `
            -Value $row.seriesIndex `
            -Path "$rowPath.seriesIndex"
        if ($rowSeriesIndex -ne $rowIndex -or $values.Count -ne $categories.Count) {
            throw "$rowPath dimensions are invalid."
        }
        Assert-WorkerChartLabel `
            -Label $row.labelBox `
            -Path "$rowPath.labelBox" `
            -Theme $Theme `
            -Names $Names `
            -Container $Primitive.dataGrid
        $expectedRowY = Get-WorkerRoundedCoordinate -Value (376 + $rowIndex * (60 / $seriesItems.Count))
        if (
            [string]$row.labelBox.text -cne [string]$seriesItems[$rowIndex].name -or
            [double]$row.labelBox.x -ne 48 -or
            -not (Test-WorkerGeometryClose -Left ([double]$row.labelBox.y) -Right $expectedRowY) -or
            [double]$row.labelBox.w -ne 64 -or
            -not (Test-WorkerGeometryClose -Left ([double]$row.labelBox.h) -Right (60 / $seriesItems.Count))
        ) {
            throw "$rowPath.labelBox has invalid geometry or source text."
        }
        for ($valueIndex = 0; $valueIndex -lt $values.Count; $valueIndex++) {
            $cell = $values[$valueIndex]
            $cellPath = "$rowPath.values[$valueIndex]"
            Assert-WorkerExactProperties `
                -Value $cell `
                -Expected @('categoryIndex', 'value', 'labelBox') `
                -Path $cellPath
            $value = Get-WorkerFiniteNumber -Value $cell.value -Path "$cellPath.value"
            $cellCategoryIndex = Get-WorkerSafeInteger `
                -Value $cell.categoryIndex `
                -Path "$cellPath.categoryIndex"
            if (
                $cellCategoryIndex -ne $valueIndex -or
                $value -ne $allValues[$rowIndex * $categories.Count + $valueIndex]
            ) {
                throw "$cellPath does not match its chart mark."
            }
            Assert-WorkerChartLabel `
                -Label $cell.labelBox `
                -Path "$cellPath.labelBox" `
                -Theme $Theme `
                -Names $Names `
                -Container $Primitive.dataGrid
            if (
                -not (Test-WorkerGeometryClose -Left ([double]$cell.labelBox.x) -Right (112 + $valueIndex * $expectedValueWidth)) -or
                -not (Test-WorkerGeometryClose -Left ([double]$cell.labelBox.y) -Right $expectedRowY) -or
                -not (Test-WorkerGeometryClose -Left ([double]$cell.labelBox.w) -Right $expectedValueWidth) -or
                -not (Test-WorkerGeometryClose -Left ([double]$cell.labelBox.h) -Right (60 / $seriesItems.Count))
            ) {
                throw "$cellPath.labelBox has invalid data-label geometry."
            }
            if (-not (Test-WorkerNumericLabelMatches -Label ([string]$cell.labelBox.text) -Value $cell.value)) {
                throw "$cellPath.labelBox text does not preserve its numeric source value."
            }
        }
    }

    $groupWidth = [double]$Primitive.plot.w / $categories.Count
    $usableWidth = $groupWidth * 0.84
    $barGap = [math]::Max(1.0, $groupWidth * 0.02)
    $barWidth = ($usableWidth - $barGap * ($seriesItems.Count - 1)) / $seriesItems.Count
    $barBoxes = [Collections.Generic.List[object]]::new()
    for ($seriesIndex = 0; $seriesIndex -lt $seriesItems.Count; $seriesIndex++) {
        $series = $seriesItems[$seriesIndex]
        $seriesPath = "$Path.series[$seriesIndex]"
        if ($Primitive.chartType -ceq 'bar') {
            Assert-WorkerJsonArray `
                -Value $series.bars `
                -Path "$seriesPath.bars" `
                -Nonempty
            $bars = $series.bars
            for ($categoryIndex = 0; $categoryIndex -lt $bars.Count; $categoryIndex++) {
                $bar = $bars[$categoryIndex]
                $barPath = "$seriesPath.bars[$categoryIndex]"
                Assert-WorkerExactProperties `
                    -Value $bar `
                    -Expected @(
                        'kind',
                        'name',
                        'categoryIndex',
                        'value',
                        'x',
                        'y',
                        'w',
                        'h',
                        'fillTransparency'
                    ) `
                    -Path $barPath
                Register-WorkerShapeName -Value $bar.name -Path "$barPath.name" -Names $Names
                Assert-WorkerBox -Value $bar -Path $barPath
                $barFillTransparency = Get-WorkerFiniteNumber `
                    -Value $bar.fillTransparency `
                    -Path "$barPath.fillTransparency"
                $value = [double]$bar.value
                $groupX = [double]$Primitive.plot.x + $categoryIndex * $groupWidth + ($groupWidth - $usableWidth) / 2
                $expectedX = Get-WorkerRoundedCoordinate -Value ($groupX + $seriesIndex * ($barWidth + $barGap))
                $valueY = Get-WorkerChartY -Value $value -Axis $Primitive.axis -Plot $Primitive.plot
                $height = Get-WorkerRoundedCoordinate -Value ([math]::Abs($valueY - [double]$Primitive.axis.zeroY))
                $visibleHeight = if ($value -eq 0) { 1.0 } else { [math]::Max(1.0, $height) }
                $expectedY = if ($value -eq 0) {
                    Get-WorkerRoundedCoordinate -Value (
                        [math]::Max(
                            [double]$Primitive.plot.y,
                            [math]::Min(
                                [double]$Primitive.plot.y + [double]$Primitive.plot.h - 1,
                                [double]$Primitive.axis.zeroY - 0.5
                            )
                        )
                    )
                }
                elseif ($value -gt 0) {
                    Get-WorkerRoundedCoordinate -Value (
                        [math]::Max(
                            [double]$Primitive.plot.y,
                            [double]$Primitive.axis.zeroY - $visibleHeight
                        )
                    )
                }
                else {
                    Get-WorkerRoundedCoordinate -Value (
                        [math]::Min(
                            [double]$Primitive.axis.zeroY,
                            [double]$Primitive.plot.y + [double]$Primitive.plot.h - $visibleHeight
                        )
                    )
                }
                $expectedKind = if ($value -eq 0) { 'line' } else { 'rect' }
                if (
                    $bar.kind -isnot [string] -or
                    $bar.kind -cne $expectedKind -or
                    -not (Test-WorkerGeometryClose -Left ([double]$bar.x) -Right $expectedX) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$bar.y) -Right $expectedY) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$bar.w) -Right $barWidth) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$bar.h) -Right $visibleHeight) -or
                    $barFillTransparency -ne 0 -or
                    -not (Test-WorkerBoxWithin -Inner $bar -Outer $Primitive.plot)
                ) {
                    throw "$barPath has invalid bar geometry: expected $expectedKind at $expectedX,$expectedY,$barWidth,$visibleHeight; found $($bar.kind) at $($bar.x),$($bar.y),$($bar.w),$($bar.h)."
                }
                $barBoxes.Add($bar)
            }
        }
        else {
            Assert-WorkerJsonArray `
                -Value $series.markers `
                -Path "$seriesPath.markers" `
                -Nonempty
            Assert-WorkerJsonArray `
                -Value $series.segments `
                -Path "$seriesPath.segments" `
                -Nonempty
            $markers = $series.markers
            $segments = $series.segments
            if ($segments.Count -ne $categories.Count - 1) {
                throw "$seriesPath.segments must join adjacent categories."
            }
            for ($categoryIndex = 0; $categoryIndex -lt $markers.Count; $categoryIndex++) {
                $marker = $markers[$categoryIndex]
                $markerPath = "$seriesPath.markers[$categoryIndex]"
                Assert-WorkerExactProperties `
                    -Value $marker `
                    -Expected @('name', 'categoryIndex', 'value', 'cx', 'cy', 'diameter') `
                    -Path $markerPath
                Register-WorkerShapeName -Value $marker.name -Path "$markerPath.name" -Names $Names
                foreach ($key in @('value', 'cx', 'cy', 'diameter')) {
                    [void](Get-WorkerFiniteNumber -Value $marker.$key -Path "$markerPath.$key")
                }
                $markerCategoryIndex = Get-WorkerSafeInteger `
                    -Value $marker.categoryIndex `
                    -Path "$markerPath.categoryIndex"
                $expectedX = Get-WorkerRoundedCoordinate -Value (
                    [double]$Primitive.plot.x + ($categoryIndex + 0.5) * $groupWidth
                )
                $expectedY = Get-WorkerChartY `
                    -Value ([double]$marker.value) `
                    -Axis $Primitive.axis `
                    -Plot $Primitive.plot
                if (
                    $markerCategoryIndex -ne $categoryIndex -or
                    [double]$marker.diameter -ne 6 -or
                    -not (Test-WorkerGeometryClose -Left ([double]$marker.cx) -Right $expectedX) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$marker.cy) -Right $expectedY) -or
                    [double]$marker.cx -lt [double]$Primitive.plot.x -or
                    [double]$marker.cx -gt [double]$Primitive.plot.x + [double]$Primitive.plot.w -or
                    [double]$marker.cy -lt [double]$Primitive.plot.y -or
                    [double]$marker.cy -gt [double]$Primitive.plot.y + [double]$Primitive.plot.h
                ) {
                    throw "$markerPath has invalid marker geometry."
                }
            }
            for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
                $segment = $segments[$segmentIndex]
                $segmentPath = "$seriesPath.segments[$segmentIndex]"
                Assert-WorkerExactProperties `
                    -Value $segment `
                    -Expected @(
                        'name',
                        'fromCategoryIndex',
                        'toCategoryIndex',
                        'x1',
                        'y1',
                        'x2',
                        'y2'
                    ) `
                    -Path $segmentPath
                Register-WorkerShapeName -Value $segment.name -Path "$segmentPath.name" -Names $Names
                foreach ($key in @('x1', 'y1', 'x2', 'y2')) {
                    [void](Get-WorkerFiniteNumber -Value $segment.$key -Path "$segmentPath.$key")
                }
                $fromCategoryIndex = Get-WorkerSafeInteger `
                    -Value $segment.fromCategoryIndex `
                    -Path "$segmentPath.fromCategoryIndex"
                $toCategoryIndex = Get-WorkerSafeInteger `
                    -Value $segment.toCategoryIndex `
                    -Path "$segmentPath.toCategoryIndex"
                $leftMarker = $markers[$segmentIndex]
                $rightMarker = $markers[$segmentIndex + 1]
                if (
                    $fromCategoryIndex -ne $segmentIndex -or
                    $toCategoryIndex -ne $segmentIndex + 1 -or
                    -not (Test-WorkerGeometryClose -Left ([double]$segment.x1) -Right ([double]$leftMarker.cx)) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$segment.y1) -Right ([double]$leftMarker.cy)) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$segment.x2) -Right ([double]$rightMarker.cx)) -or
                    -not (Test-WorkerGeometryClose -Left ([double]$segment.y2) -Right ([double]$rightMarker.cy)) -or
                    (
                        [double]$segment.x1 -eq [double]$segment.x2 -and
                        [double]$segment.y1 -eq [double]$segment.y2
                    )
                ) {
                    throw "$segmentPath has invalid segment geometry."
                }
            }
        }
    }
    for ($leftIndex = 0; $leftIndex -lt $barBoxes.Count; $leftIndex++) {
        for ($rightIndex = $leftIndex + 1; $rightIndex -lt $barBoxes.Count; $rightIndex++) {
            $leftBar = $barBoxes[$leftIndex]
            $rightBar = $barBoxes[$rightIndex]
            $overlap = (
                [double]$leftBar.x -lt [double]$rightBar.x + [double]$rightBar.w - 0.0005 -and
                [double]$rightBar.x -lt [double]$leftBar.x + [double]$leftBar.w - 0.0005 -and
                [double]$leftBar.y -lt [double]$rightBar.y + [double]$rightBar.h - 0.0005 -and
                [double]$rightBar.y -lt [double]$leftBar.y + [double]$leftBar.h - 0.0005
            )
            if ($overlap) {
                throw "$Path contains overlapping bars."
            }
        }
    }

    $boundsName = Get-NativeChartBoundsShapeName -ChartName ([string]$Primitive.name)
    Register-WorkerShapeName -Value $boundsName -Path "$Path.derivedBoundsName" -Names $Names
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

function New-ChartTextLeaf {
    param([Parameter(Mandatory = $true)]$Label)

    $maxLines = [math]::Max(1, [math]::Floor([double]$Label.h / 8))
    return [pscustomobject][ordered]@{
        kind = 'text'
        name = [string]$Label.name
        x = [double]$Label.x
        y = [double]$Label.y
        w = [double]$Label.w
        h = [double]$Label.h
        text = [string]$Label.text
        fontSize = [double]$Label.fontSize
        bold = [bool]$Label.bold
        italic = $false
        colorRole = [string]$Label.colorRole
        horizontalAlign = [string]$Label.horizontalAlign
        verticalAlign = [string]$Label.verticalAlign
        rotation = [double]$Label.rotation
        marginLeft = 0
        marginRight = 0
        marginTop = 0
        marginBottom = 0
        wordWrap = $true
        autoFit = 'none'
        maxLines = $maxLines
    }
}

function New-ChartShapeLeaf {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ShapeType,
        [Parameter(Mandatory = $true)][double]$X,
        [Parameter(Mandatory = $true)][double]$Y,
        [Parameter(Mandatory = $true)][double]$W,
        [Parameter(Mandatory = $true)][double]$H,
        [Parameter(Mandatory = $true)][bool]$FillVisible,
        [Parameter(Mandatory = $true)][string]$FillColorRole,
        [Parameter(Mandatory = $true)][double]$FillTransparency,
        [Parameter(Mandatory = $true)][bool]$LineVisible,
        [Parameter(Mandatory = $true)][string]$LineColorRole,
        [Parameter(Mandatory = $true)][double]$LineTransparency,
        [Parameter(Mandatory = $true)][double]$LineWidth,
        [Parameter(Mandatory = $true)][string]$LineDash
    )

    return [pscustomobject][ordered]@{
        kind = 'shape'
        name = $Name
        shapeType = $ShapeType
        x = $X
        y = $Y
        w = $W
        h = $H
        fillVisible = $FillVisible
        fillColorRole = $FillColorRole
        fillTransparency = $FillTransparency
        lineVisible = $LineVisible
        lineColorRole = $LineColorRole
        lineTransparency = $LineTransparency
        lineWidth = $LineWidth
        lineDash = $LineDash
    }
}

function New-ChartLineLeaf {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][double]$X1,
        [Parameter(Mandatory = $true)][double]$Y1,
        [Parameter(Mandatory = $true)][double]$X2,
        [Parameter(Mandatory = $true)][double]$Y2,
        [Parameter(Mandatory = $true)][string]$ColorRole,
        [Parameter(Mandatory = $true)][double]$Width,
        [Parameter(Mandatory = $true)][string]$Dash,
        [Parameter(Mandatory = $true)][double]$Transparency
    )

    return [pscustomobject][ordered]@{
        kind = 'line'
        name = $Name
        x1 = $X1
        y1 = $Y1
        x2 = $X2
        y2 = $Y2
        colorRole = $ColorRole
        width = $Width
        dash = $Dash
        transparency = $Transparency
        arrowStart = 'none'
        arrowEnd = 'none'
    }
}

function Convert-NamedChartLineToLeaf {
    param([Parameter(Mandatory = $true)]$LineSpec)

    return New-ChartLineLeaf `
        -Name ([string]$LineSpec.name) `
        -X1 ([double]$LineSpec.x1) `
        -Y1 ([double]$LineSpec.y1) `
        -X2 ([double]$LineSpec.x2) `
        -Y2 ([double]$LineSpec.y2) `
        -ColorRole ([string]$LineSpec.colorRole) `
        -Width ([double]$LineSpec.width) `
        -Dash ([string]$LineSpec.dash) `
        -Transparency ([double]$LineSpec.transparency)
}

function Get-NativeChartLeafSpecs {
    param([Parameter(Mandatory = $true)]$Primitive)

    $leaves = [Collections.Generic.List[object]]::new()
    $leaves.Add((New-ChartShapeLeaf `
        -Name (Get-NativeChartBoundsShapeName -ChartName ([string]$Primitive.name)) `
        -ShapeType 'rect' `
        -X ([double]$Primitive.x) `
        -Y ([double]$Primitive.y) `
        -W ([double]$Primitive.w) `
        -H ([double]$Primitive.h) `
        -FillVisible $false `
        -FillColorRole 'background' `
        -FillTransparency 0 `
        -LineVisible $false `
        -LineColorRole 'line' `
        -LineTransparency 0 `
        -LineWidth 0.75 `
        -LineDash 'solid'))

    $ticks = @($Primitive.axis.ticks)
    for ($tickIndex = 0; $tickIndex -lt $ticks.Count; $tickIndex++) {
        $leaves.Add((Convert-NamedChartLineToLeaf -LineSpec $ticks[$tickIndex].gridLine))
    }

    $seriesItems = @($Primitive.series)
    if ([string]$Primitive.chartType -eq 'bar') {
        for ($seriesIndex = 0; $seriesIndex -lt $seriesItems.Count; $seriesIndex++) {
            $series = $seriesItems[$seriesIndex]
            $bars = @($series.bars)
            for ($barIndex = 0; $barIndex -lt $bars.Count; $barIndex++) {
                $bar = $bars[$barIndex]
                if ([string]$bar.kind -eq 'line') {
                    $leaves.Add((New-ChartLineLeaf `
                        -Name ([string]$bar.name) `
                        -X1 ([double]$bar.x) `
                        -Y1 ([double]$bar.y + [double]$bar.h / 2) `
                        -X2 ([double]$bar.x + [double]$bar.w) `
                        -Y2 ([double]$bar.y + [double]$bar.h / 2) `
                        -ColorRole ([string]$series.colorRole) `
                        -Width 1 `
                        -Dash 'solid' `
                        -Transparency 0))
                }
                else {
                    $leaves.Add((New-ChartShapeLeaf `
                        -Name ([string]$bar.name) `
                        -ShapeType 'rect' `
                        -X ([double]$bar.x) `
                        -Y ([double]$bar.y) `
                        -W ([double]$bar.w) `
                        -H ([double]$bar.h) `
                        -FillVisible $true `
                        -FillColorRole ([string]$series.colorRole) `
                        -FillTransparency ([double]$bar.fillTransparency) `
                        -LineVisible $false `
                        -LineColorRole ([string]$series.colorRole) `
                        -LineTransparency 0 `
                        -LineWidth 0.75 `
                        -LineDash 'solid'))
                }
            }
        }
    }
    else {
        for ($seriesIndex = 0; $seriesIndex -lt $seriesItems.Count; $seriesIndex++) {
            $series = $seriesItems[$seriesIndex]
            $segments = @($series.segments)
            for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
                $segment = $segments[$segmentIndex]
                $leaves.Add((New-ChartLineLeaf `
                    -Name ([string]$segment.name) `
                    -X1 ([double]$segment.x1) `
                    -Y1 ([double]$segment.y1) `
                    -X2 ([double]$segment.x2) `
                    -Y2 ([double]$segment.y2) `
                    -ColorRole ([string]$series.colorRole) `
                    -Width 2 `
                    -Dash ([string]$series.dash) `
                    -Transparency 0))
            }
        }
    }

    $leaves.Add((Convert-NamedChartLineToLeaf -LineSpec $Primitive.axis.baseline))

    if ([string]$Primitive.chartType -eq 'line') {
        for ($seriesIndex = 0; $seriesIndex -lt $seriesItems.Count; $seriesIndex++) {
            $series = $seriesItems[$seriesIndex]
            $markers = @($series.markers)
            for ($markerIndex = 0; $markerIndex -lt $markers.Count; $markerIndex++) {
                $marker = $markers[$markerIndex]
                $diameter = [double]$marker.diameter
                $leaves.Add((New-ChartShapeLeaf `
                    -Name ([string]$marker.name) `
                    -ShapeType 'ellipse' `
                    -X ([double]$marker.cx - $diameter / 2) `
                    -Y ([double]$marker.cy - $diameter / 2) `
                    -W $diameter `
                    -H $diameter `
                    -FillVisible $true `
                    -FillColorRole ([string]$series.colorRole) `
                    -FillTransparency 0 `
                    -LineVisible $true `
                    -LineColorRole ([string]$series.colorRole) `
                    -LineTransparency 0 `
                    -LineWidth 0.75 `
                    -LineDash 'solid'))
            }
        }
    }

    $legend = @($Primitive.legend)
    for ($legendIndex = 0; $legendIndex -lt $legend.Count; $legendIndex++) {
        $entry = $legend[$legendIndex]
        $series = $seriesItems[$legendIndex]
        if ([string]$Primitive.chartType -eq 'bar') {
            $leaves.Add((New-ChartShapeLeaf `
                -Name ([string]$entry.swatchName) `
                -ShapeType 'rect' `
                -X ([double]$entry.swatch.x) `
                -Y ([double]$entry.swatch.y) `
                -W ([double]$entry.swatch.w) `
                -H ([double]$entry.swatch.h) `
                -FillVisible $true `
                -FillColorRole ([string]$entry.colorRole) `
                -FillTransparency 0 `
                -LineVisible $false `
                -LineColorRole ([string]$entry.colorRole) `
                -LineTransparency 0 `
                -LineWidth 0.75 `
                -LineDash 'solid'))
        }
        else {
            $swatchY = [double]$entry.swatch.y + [double]$entry.swatch.h / 2
            $leaves.Add((New-ChartLineLeaf `
                -Name ([string]$entry.swatchName) `
                -X1 ([double]$entry.swatch.x) `
                -Y1 $swatchY `
                -X2 ([double]$entry.swatch.x + [double]$entry.swatch.w) `
                -Y2 $swatchY `
                -ColorRole ([string]$entry.colorRole) `
                -Width 2 `
                -Dash ([string]$series.dash) `
                -Transparency 0))
        }
    }

    $leaves.Add((New-ChartTextLeaf -Label $Primitive.unitLabel))
    for ($tickIndex = 0; $tickIndex -lt $ticks.Count; $tickIndex++) {
        $leaves.Add((New-ChartTextLeaf -Label $ticks[$tickIndex].labelBox))
    }
    $categories = @($Primitive.categories)
    for ($categoryIndex = 0; $categoryIndex -lt $categories.Count; $categoryIndex++) {
        $leaves.Add((New-ChartTextLeaf -Label $categories[$categoryIndex].labelBox))
    }
    for ($legendIndex = 0; $legendIndex -lt $legend.Count; $legendIndex++) {
        $leaves.Add((New-ChartTextLeaf -Label $legend[$legendIndex].labelBox))
    }
    $rows = @($Primitive.dataGrid.rows)
    for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
        $row = $rows[$rowIndex]
        $leaves.Add((New-ChartTextLeaf -Label $row.labelBox))
        $values = @($row.values)
        for ($valueIndex = 0; $valueIndex -lt $values.Count; $valueIndex++) {
            $leaves.Add((New-ChartTextLeaf -Label $values[$valueIndex].labelBox))
        }
    }

    return $leaves.ToArray()
}

function Add-NativeChartPrimitive {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)]$Theme
    )

    $leafSpecs = @(Get-NativeChartLeafSpecs -Primitive $Primitive)
    $childNames = [Collections.Generic.List[string]]::new()
    $shapeRange = $null
    $groupShape = $null
    try {
        for ($leafIndex = 0; $leafIndex -lt $leafSpecs.Count; $leafIndex++) {
            $leaf = $leafSpecs[$leafIndex]
            switch ([string]$leaf.kind) {
                'text' {
                    Add-TextPrimitive -Shapes $Shapes -Primitive $leaf -Theme $Theme
                }
                'shape' {
                    Add-ShapePrimitive -Shapes $Shapes -Primitive $leaf -Theme $Theme
                }
                'line' {
                    Add-LinePrimitive -Shapes $Shapes -Primitive $leaf -Theme $Theme
                }
                default {
                    throw "Unsupported native chart leaf kind '$($leaf.kind)'."
                }
            }
            $childNames.Add([string]$leaf.name)
        }
        $shapeRange = $Shapes.Range([object[]]$childNames.ToArray())
        $groupShape = $shapeRange.Group()
        $groupShape.Name = [string]$Primitive.name
    }
    finally {
        Release-ComRef -Reference ([ref]$groupShape) -Label 'native chart group shape'
        Release-ComRef -Reference ([ref]$shapeRange) -Label 'native chart shape range'
    }
}

function Format-WorkerRecordNumber {
    param([Parameter(Mandatory = $true)][double]$Value)

    $rounded = [math]::Round($Value, 3, [MidpointRounding]::AwayFromZero)
    return $rounded.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
}

function Assert-WorkerActualNear {
    param(
        [Parameter(Mandatory = $true)][double]$Actual,
        [Parameter(Mandatory = $true)][double]$Expected,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ([math]::Abs($Actual - $Expected) -gt 0.02) {
        throw "$Message Expected $Expected, found $Actual."
    }
}

function Assert-LeafShape {
    param(
        [Parameter(Mandatory = $true)]$Shape,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$ExpectedZ,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $shapeFill = $null
    $fillColor = $null
    $shapeLine = $null
    $lineColor = $null
    $legacyFrame = $null
    $frame2 = $null
    $range2 = $null
    $font2 = $null
    $fontFill = $null
    $fontColor = $null
    $paragraph = $null
    $renderedLines = $null
    try {
        if (-not [string]::Equals([string]$Shape.Name, [string]$Expected.name, [StringComparison]::Ordinal)) {
            throw "$Path name does not match '$($Expected.name)'."
        }
        if ([string]$Expected.kind -eq 'line') {
            if ([int]$Shape.Type -ne 9) {
                throw "$Path is not a native line shape."
            }
            $expectedLeft = [math]::Min([double]$Expected.x1, [double]$Expected.x2)
            $expectedTop = [math]::Min([double]$Expected.y1, [double]$Expected.y2)
            $expectedWidth = [math]::Abs([double]$Expected.x2 - [double]$Expected.x1)
            $expectedHeight = [math]::Abs([double]$Expected.y2 - [double]$Expected.y1)
            Assert-WorkerActualNear -Actual ([double]$Shape.Left) -Expected $expectedLeft -Message "$Path left differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Top) -Expected $expectedTop -Message "$Path top differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Width) -Expected $expectedWidth -Message "$Path width differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Height) -Expected $expectedHeight -Message "$Path height differs."
            $expectedHorizontalFlip = if ([double]$Expected.x2 -lt [double]$Expected.x1) { -1 } else { 0 }
            $expectedVerticalFlip = if ([double]$Expected.y2 -lt [double]$Expected.y1) { -1 } else { 0 }
            if (
                [int]$Shape.HorizontalFlip -ne $expectedHorizontalFlip -or
                [int]$Shape.VerticalFlip -ne $expectedVerticalFlip
            ) {
                throw "$Path line orientation differs from the drawing spec."
            }

            $shapeLine = $Shape.Line
            $lineColor = $shapeLine.ForeColor
            $expectedColor = Get-RoleColor -Theme $Theme -Role ([string]$Expected.colorRole)
            $expectedBeginArrowhead = if ($Expected.arrowStart -ceq 'open') { 3 } else { 1 }
            $expectedEndArrowhead = if ($Expected.arrowEnd -ceq 'open') { 3 } else { 1 }
            if (
                [int]$shapeLine.Visible -ne -1 -or
                [int]$lineColor.RGB -ne $expectedColor -or
                [math]::Abs([double]$shapeLine.Transparency - [double]$Expected.transparency) -gt 0.001 -or
                [math]::Abs([double]$shapeLine.Weight - [double]$Expected.width) -gt 0.001 -or
                [int]$shapeLine.DashStyle -ne (Get-DashStyle -Dash ([string]$Expected.dash)) -or
                [int]$shapeLine.BeginArrowheadStyle -ne $expectedBeginArrowhead -or
                [int]$shapeLine.EndArrowheadStyle -ne $expectedEndArrowhead
            ) {
                throw "$Path line style differs from the drawing spec."
            }
            return [pscustomobject][ordered]@{
                name = [string]$Shape.Name
                geometry = @(
                    Format-WorkerRecordNumber -Value ([double]$Shape.Left)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Top)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Width)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Height)
                    [string][int]$Shape.HorizontalFlip
                    [string][int]$Shape.VerticalFlip
                ) -join ','
                content = ''
                style = "$([int]$lineColor.RGB),$(Format-WorkerRecordNumber -Value ([double]$shapeLine.Transparency)),$(Format-WorkerRecordNumber -Value ([double]$shapeLine.Weight)),$([int]$shapeLine.DashStyle)"
            }
        }

        if ([string]$Expected.kind -eq 'shape') {
            if ([int]$Shape.Type -ne 1) {
                throw "$Path is not a native auto shape."
            }
            Assert-WorkerActualNear -Actual ([double]$Shape.Left) -Expected ([double]$Expected.x) -Message "$Path left differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Top) -Expected ([double]$Expected.y) -Message "$Path top differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Width) -Expected ([double]$Expected.w) -Message "$Path width differs."
            Assert-WorkerActualNear -Actual ([double]$Shape.Height) -Expected ([double]$Expected.h) -Message "$Path height differs."
            if ([int]$Shape.AutoShapeType -ne (Get-ShapeType -ShapeType ([string]$Expected.shapeType))) {
                throw "$Path auto-shape type differs from the drawing spec."
            }

            $shapeFill = $Shape.Fill
            if ($Expected.fillVisible) {
                $fillColor = $shapeFill.ForeColor
                if (
                    [int]$shapeFill.Visible -ne -1 -or
                    [int]$fillColor.RGB -ne (Get-RoleColor -Theme $Theme -Role ([string]$Expected.fillColorRole)) -or
                    [math]::Abs([double]$shapeFill.Transparency - [double]$Expected.fillTransparency) -gt 0.001
                ) {
                    throw "$Path fill style differs from the drawing spec."
                }
            }
            elseif ([int]$shapeFill.Visible -ne 0) {
                throw "$Path fill must be invisible."
            }

            $shapeLine = $Shape.Line
            if ($Expected.lineVisible) {
                $lineColor = $shapeLine.ForeColor
                if (
                    [int]$shapeLine.Visible -ne -1 -or
                    [int]$lineColor.RGB -ne (Get-RoleColor -Theme $Theme -Role ([string]$Expected.lineColorRole)) -or
                    [math]::Abs([double]$shapeLine.Transparency - [double]$Expected.lineTransparency) -gt 0.001 -or
                    [math]::Abs([double]$shapeLine.Weight - [double]$Expected.lineWidth) -gt 0.001 -or
                    [int]$shapeLine.DashStyle -ne (Get-DashStyle -Dash ([string]$Expected.lineDash))
                ) {
                    throw "$Path outline style differs from the drawing spec."
                }
            }
            elseif ([int]$shapeLine.Visible -ne 0) {
                throw "$Path outline must be invisible."
            }

            $fillStyle = if ($Expected.fillVisible) {
                "$([int]$fillColor.RGB),$(Format-WorkerRecordNumber -Value ([double]$shapeFill.Transparency))"
            }
            else {
                'none'
            }
            $lineStyle = if ($Expected.lineVisible) {
                "$([int]$lineColor.RGB),$(Format-WorkerRecordNumber -Value ([double]$shapeLine.Transparency)),$(Format-WorkerRecordNumber -Value ([double]$shapeLine.Weight)),$([int]$shapeLine.DashStyle)"
            }
            else {
                'none'
            }
            return [pscustomobject][ordered]@{
                name = [string]$Shape.Name
                geometry = @(
                    Format-WorkerRecordNumber -Value ([double]$Shape.Left)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Top)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Width)
                    Format-WorkerRecordNumber -Value ([double]$Shape.Height)
                ) -join ','
                content = ''
                style = "$fillStyle|$lineStyle"
            }
        }

        if ([string]$Expected.kind -ne 'text' -or [int]$Shape.Type -ne 17) {
            throw "$Path is not a native text box."
        }
        Assert-WorkerActualNear -Actual ([double]$Shape.Left) -Expected ([double]$Expected.x) -Message "$Path left differs."
        Assert-WorkerActualNear -Actual ([double]$Shape.Top) -Expected ([double]$Expected.y) -Message "$Path top differs."
        Assert-WorkerActualNear -Actual ([double]$Shape.Width) -Expected ([double]$Expected.w) -Message "$Path width differs."
        Assert-WorkerActualNear -Actual ([double]$Shape.Height) -Expected ([double]$Expected.h) -Message "$Path height differs."
        Assert-WorkerActualNear -Actual ([double]$Shape.Rotation) -Expected ([double]$Expected.rotation) -Message "$Path rotation differs."

        $shapeFill = $Shape.Fill
        $shapeLine = $Shape.Line
        if ([int]$shapeFill.Visible -ne 0 -or [int]$shapeLine.Visible -ne 0) {
            throw "$Path text box fill and line must be invisible."
        }
        $legacyFrame = $Shape.TextFrame
        if ([int]$legacyFrame.AutoSize -ne 0) {
            throw "$Path legacy text auto-size must be disabled."
        }
        $frame2 = $Shape.TextFrame2
        $expectedWordWrap = if ($Expected.wordWrap) { -1 } else { 0 }
        if (
            [int]$frame2.AutoSize -ne 0 -or
            [int]$frame2.WordWrap -ne $expectedWordWrap -or
            [int]$frame2.VerticalAnchor -ne (Get-VerticalAlignment -Alignment ([string]$Expected.verticalAlign)) -or
            [math]::Abs([double]$frame2.MarginLeft - [double]$Expected.marginLeft) -gt 0.001 -or
            [math]::Abs([double]$frame2.MarginRight - [double]$Expected.marginRight) -gt 0.001 -or
            [math]::Abs([double]$frame2.MarginTop - [double]$Expected.marginTop) -gt 0.001 -or
            [math]::Abs([double]$frame2.MarginBottom - [double]$Expected.marginBottom) -gt 0.001
        ) {
            throw "$Path text-frame style differs from the drawing spec."
        }
        $range2 = $frame2.TextRange
        if (-not [string]::Equals([string]$range2.Text, [string]$Expected.text, [StringComparison]::Ordinal)) {
            throw "$Path text content differs from the drawing spec."
        }
        $font2 = $range2.Font
        $fontFill = $font2.Fill
        $fontColor = $fontFill.ForeColor
        $paragraph = $range2.ParagraphFormat
        $expectedBold = if ($Expected.bold) { -1 } else { 0 }
        $expectedItalic = if ($Expected.italic) { -1 } else { 0 }
        if (
            -not [string]::Equals([string]$font2.Name, [string]$Theme.fontFamily, [StringComparison]::Ordinal) -or
            [math]::Abs([double]$font2.Size - [double]$Expected.fontSize) -gt 0.001 -or
            [int]$font2.Bold -ne $expectedBold -or
            [int]$font2.Italic -ne $expectedItalic -or
            [int]$fontColor.RGB -ne (Get-RoleColor -Theme $Theme -Role ([string]$Expected.colorRole)) -or
            [int]$paragraph.Alignment -ne (Get-HorizontalAlignment -Alignment ([string]$Expected.horizontalAlign))
        ) {
            throw "$Path text style differs from the drawing spec."
        }

        $availableHeight = [double]$Shape.Height -
            [double]$frame2.MarginTop -
            [double]$frame2.MarginBottom +
            2
        $availableWidth = [double]$Shape.Width -
            [double]$frame2.MarginLeft -
            [double]$frame2.MarginRight +
            2
        if ([double]$range2.BoundHeight -gt $availableHeight) {
            throw "Text overflow in $($Shape.Name)."
        }
        if ([int]$frame2.WordWrap -eq 0 -and [double]$range2.BoundWidth -gt $availableWidth) {
            throw "Text width overflow in $($Shape.Name)."
        }
        $renderedLines = $range2.Lines()
        if ([int]$renderedLines.Count -gt [double]$Expected.maxLines) {
            throw "Text in $($Shape.Name) renders as $($renderedLines.Count) lines, exceeding maxLines $($Expected.maxLines)."
        }

        return [pscustomobject][ordered]@{
            name = [string]$Shape.Name
            geometry = @(
                Format-WorkerRecordNumber -Value ([double]$Shape.Left)
                Format-WorkerRecordNumber -Value ([double]$Shape.Top)
                Format-WorkerRecordNumber -Value ([double]$Shape.Width)
                Format-WorkerRecordNumber -Value ([double]$Shape.Height)
            ) -join ','
            content = [string]$range2.Text
            style = "$([string]$font2.Name),$(Format-WorkerRecordNumber -Value ([double]$font2.Size)),$([int]$font2.Bold),$([int]$font2.Italic),$([int]$fontColor.RGB),$([int]$paragraph.Alignment),$([int]$frame2.VerticalAnchor)"
        }
    }
    finally {
        Release-ComRef -Reference ([ref]$renderedLines) -Label 'nested rendered text range'
        Release-ComRef -Reference ([ref]$paragraph) -Label 'nested paragraph format'
        Release-ComRef -Reference ([ref]$fontColor) -Label 'nested font color'
        Release-ComRef -Reference ([ref]$fontFill) -Label 'nested font fill'
        Release-ComRef -Reference ([ref]$font2) -Label 'nested font'
        Release-ComRef -Reference ([ref]$range2) -Label 'nested text range'
        Release-ComRef -Reference ([ref]$frame2) -Label 'nested text frame 2'
        Release-ComRef -Reference ([ref]$legacyFrame) -Label 'nested legacy text frame'
        Release-ComRef -Reference ([ref]$lineColor) -Label 'nested line color'
        Release-ComRef -Reference ([ref]$shapeLine) -Label 'nested line'
        Release-ComRef -Reference ([ref]$fillColor) -Label 'nested fill color'
        Release-ComRef -Reference ([ref]$shapeFill) -Label 'nested fill'
    }
}

function Assert-SlideShapeTree {
    param(
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$SlideSpec,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    $records = [Collections.Generic.List[object]]::new()
    $chartRecords = [Collections.Generic.List[object]]::new()
    $primitiveCount = @($SlideSpec.primitives).Count
    if ([int]$Shapes.Count -ne $primitiveCount) {
        throw "Final top-level shape count does not match the spec on slide $SlideIndex."
    }
    for ($primitiveIndex = 0; $primitiveIndex -lt $primitiveCount; $primitiveIndex++) {
        $primitive = $SlideSpec.primitives[$primitiveIndex]
        $shape = $null
        $groupItems = $null
        try {
            $shape = $Shapes.Item($primitiveIndex + 1)
            if ([string]$primitive.kind -eq 'nativeChart') {
                if (
                    [int]$shape.Type -ne 6 -or
                    -not [string]::Equals([string]$shape.Name, [string]$primitive.name, [StringComparison]::Ordinal)
                ) {
                    throw "Native chart group identity differs on slide $SlideIndex."
                }
                Assert-WorkerActualNear -Actual ([double]$shape.Left) -Expected ([double]$primitive.x) -Message 'Native chart left differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Top) -Expected ([double]$primitive.y) -Message 'Native chart top differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Width) -Expected ([double]$primitive.w) -Message 'Native chart width differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Height) -Expected ([double]$primitive.h) -Message 'Native chart height differs.'
                $groupRecord = [pscustomobject][ordered]@{
                    name = [string]$shape.Name
                    geometry = @(
                        Format-WorkerRecordNumber -Value ([double]$shape.Left)
                        Format-WorkerRecordNumber -Value ([double]$shape.Top)
                        Format-WorkerRecordNumber -Value ([double]$shape.Width)
                        Format-WorkerRecordNumber -Value ([double]$shape.Height)
                    ) -join ','
                    content = ''
                    style = 'group'
                }
                $records.Add($groupRecord)
                $chartRecords.Add($groupRecord)

                $leafSpecs = @(Get-NativeChartLeafSpecs -Primitive $primitive)
                $groupItems = $shape.GroupItems
                if ([int]$groupItems.Count -ne $leafSpecs.Count) {
                    throw "Native chart nested shape count differs on slide $SlideIndex."
                }
                for ($leafIndex = 0; $leafIndex -lt $leafSpecs.Count; $leafIndex++) {
                    $nestedShape = $null
                    try {
                        $nestedShape = $groupItems.Item($leafIndex + 1)
                        if (-not [string]::Equals(
                            [string]$nestedShape.Name,
                            [string]$leafSpecs[$leafIndex].name,
                            [StringComparison]::Ordinal
                        )) {
                            throw "slide $SlideIndex chart leaf $($leafIndex + 1) name or z-order does not match the drawing spec."
                        }
                        $record = Assert-LeafShape `
                            -Shape $nestedShape `
                            -Expected $leafSpecs[$leafIndex] `
                            -Theme $Theme `
                            -ExpectedZ 0 `
                            -Path "slide $SlideIndex chart leaf $($leafIndex + 1)"
                        $records.Add($record)
                        $chartRecords.Add($record)
                    }
                    finally {
                        Release-ComRef -Reference ([ref]$nestedShape) -Label 'nested chart shape'
                    }
                }
            }
            elseif (
                [string]$primitive.kind -eq 'line' -and
                (Test-WorkflowConnectorPrimitive -Primitive $primitive)
            ) {
                Assert-WorkflowConnectorShape `
                    -Shape $shape `
                    -Primitive $primitive `
                    -Theme $Theme `
                    -SlideIndex $SlideIndex
                $connectorLine = $null
                $connectorColor = $null
                try {
                    $endpoints = Get-WorkflowConnectorEndpoints -Shape $shape
                    $connectorLine = $shape.Line
                    $connectorColor = $connectorLine.ForeColor
                    $records.Add([pscustomobject][ordered]@{
                        name = [string]$shape.Name
                        geometry = @(
                            Format-WorkerRecordNumber -Value ([double]$endpoints.x1)
                            Format-WorkerRecordNumber -Value ([double]$endpoints.y1)
                            Format-WorkerRecordNumber -Value ([double]$endpoints.x2)
                            Format-WorkerRecordNumber -Value ([double]$endpoints.y2)
                        ) -join ','
                        content = ''
                        style = "$([int]$connectorColor.RGB),$(Format-WorkerRecordNumber -Value ([double]$connectorLine.Transparency)),$(Format-WorkerRecordNumber -Value ([double]$connectorLine.Weight)),$([int]$connectorLine.DashStyle)"
                    })
                }
                finally {
                    Release-ComRef -Reference ([ref]$connectorColor) -Label 'shape-tree connector color'
                    Release-ComRef -Reference ([ref]$connectorLine) -Label 'shape-tree connector line'
                }
            }
            elseif ([string]$primitive.kind -eq 'table') {
                if (
                    [int]$shape.HasTable -ne -1 -or
                    -not [string]::Equals(
                        [string]$shape.Name,
                        [string]$primitive.name,
                        [StringComparison]::Ordinal
                    )
                ) {
                    throw "Native table identity differs on slide $SlideIndex."
                }
                Assert-WorkerActualNear -Actual ([double]$shape.Left) -Expected ([double]$primitive.x) -Message 'Native table left differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Top) -Expected ([double]$primitive.y) -Message 'Native table top differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Width) -Expected ([double]$primitive.w) -Message 'Native table width differs.'
                Assert-WorkerActualNear -Actual ([double]$shape.Height) -Expected ([double]$primitive.h) -Message 'Native table height differs.'
                $records.Add([pscustomobject][ordered]@{
                    name = [string]$shape.Name
                    geometry = @(
                        Format-WorkerRecordNumber -Value ([double]$shape.Left)
                        Format-WorkerRecordNumber -Value ([double]$shape.Top)
                        Format-WorkerRecordNumber -Value ([double]$shape.Width)
                        Format-WorkerRecordNumber -Value ([double]$shape.Height)
                    ) -join ','
                    content = ''
                    style = 'table'
                })
            }
            else {
                $record = Assert-LeafShape `
                    -Shape $shape `
                    -Expected $primitive `
                    -Theme $Theme `
                    -ExpectedZ 0 `
                    -Path "slide $SlideIndex primitive $($primitiveIndex + 1)"
                $records.Add($record)
            }
        }
        finally {
            Release-ComRef -Reference ([ref]$groupItems) -Label 'nested chart shapes'
            Release-ComRef -Reference ([ref]$shape) -Label 'shape-tree shape'
        }
    }

    return [pscustomobject][ordered]@{
        recursiveRecords = $records.ToArray()
        nativeChartRecords = $chartRecords.ToArray()
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
        [Parameter(Mandatory = $true)]$Shapes,
        [Parameter(Mandatory = $true)]$SlideSpec,
        [Parameter(Mandatory = $true)]$Theme,
        [Parameter(Mandatory = $true)][int]$SlideIndex
    )

    return Assert-SlideShapeTree `
        -Shapes $Shapes `
        -SlideSpec $SlideSpec `
        -Theme $Theme `
        -SlideIndex $SlideIndex
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

function Invoke-NativeChartTestMutation {
        param(
            [Parameter(Mandatory = $true)]$Shapes,
            [Parameter(Mandatory = $true)]$SlideSpec,
            [Parameter(Mandatory = $true)][string]$Mode
        )

        if ([string]::IsNullOrWhiteSpace($Mode) -or $script:nativeChartMutationApplied) {
            return
        }
        $chartIndex = -1
        for ($primitiveIndex = 0; $primitiveIndex -lt $SlideSpec.primitives.Count; $primitiveIndex++) {
            if ([string]$SlideSpec.primitives[$primitiveIndex].kind -eq 'nativeChart') {
                $chartIndex = $primitiveIndex
                break
            }
        }
        if ($chartIndex -lt 0) {
            return
        }

        $groupShape = $null
        $groupItems = $null
        $firstShape = $null
        $secondShape = $null
        $targetShape = $null
        $legacyFrame = $null
        $frame2 = $null
        $range2 = $null
        $fill = $null
        $line = $null
        $color = $null
        try {
            $groupShape = $Shapes.Item($chartIndex + 1)
            $leafSpecs = @(Get-NativeChartLeafSpecs -Primitive $SlideSpec.primitives[$chartIndex])
            switch ($Mode) {
                'geometry' {
                    $groupShape.Left = [single]([double]$groupShape.Left + 1)
                }
                'content' {
                    $targetIndex = -1
                    for ($leafIndex = 0; $leafIndex -lt $leafSpecs.Count; $leafIndex++) {
                        if ([string]$leafSpecs[$leafIndex].kind -eq 'text') {
                            $targetIndex = $leafIndex
                            break
                        }
                    }
                    if ($targetIndex -lt 0) {
                        throw 'Native chart mutation could not find a text leaf.'
                    }
                    $groupItems = $groupShape.GroupItems
                    $targetShape = $groupItems.Item($targetIndex + 1)
                    $legacyFrame = $targetShape.TextFrame
                    $frame2 = $targetShape.TextFrame2
                    $range2 = $frame2.TextRange
                    $range2.Text = "$($range2.Text)-mutated"
                }
                'style' {
                    $targetIndex = -1
                    for ($leafIndex = 0; $leafIndex -lt $leafSpecs.Count; $leafIndex++) {
                        $leaf = $leafSpecs[$leafIndex]
                        if (
                            [string]$leaf.kind -eq 'line' -or
                            ([string]$leaf.kind -eq 'shape' -and $leaf.fillVisible)
                        ) {
                            $targetIndex = $leafIndex
                            break
                        }
                    }
                    if ($targetIndex -lt 0) {
                        throw 'Native chart mutation could not find a styled leaf.'
                    }
                    $groupItems = $groupShape.GroupItems
                    $targetShape = $groupItems.Item($targetIndex + 1)
                    if ([string]$leafSpecs[$targetIndex].kind -eq 'line') {
                        $line = $targetShape.Line
                        $color = $line.ForeColor
                    }
                    else {
                        $fill = $targetShape.Fill
                        $color = $fill.ForeColor
                    }
                    $color.RGB = 0
                }
                'nested-name' {
                    $groupItems = $groupShape.GroupItems
                    if ([int]$groupItems.Count -lt 2) {
                        throw 'Native chart mutation requires two nested shapes.'
                    }
                    $firstShape = $groupItems.Item(1)
                    $secondShape = $groupItems.Item(2)
                    $secondShape.Name = [string]$firstShape.Name
                }
                'z-order' {
                    $groupItems = $groupShape.GroupItems
                    $firstShape = $groupItems.Item(1)
                    $firstShape.ZOrder(0)
                }
                'line-orientation' {
                    $targetIndex = -1
                    for ($leafIndex = 0; $leafIndex -lt $leafSpecs.Count; $leafIndex++) {
                        $leaf = $leafSpecs[$leafIndex]
                        if (
                            [string]$leaf.kind -eq 'line' -and
                            [double]$leaf.x1 -ne [double]$leaf.x2 -and
                            [double]$leaf.y1 -ne [double]$leaf.y2
                        ) {
                            $targetIndex = $leafIndex
                            break
                        }
                    }
                    if ($targetIndex -lt 0) {
                        return
                    }
                    $groupItems = $groupShape.GroupItems
                    $targetShape = $groupItems.Item($targetIndex + 1)
                    $targetShape.Flip(1)
                }
                default {
                    throw "Unsupported native chart mutation mode '$Mode'."
                }
            }
            $script:nativeChartMutationApplied = $true
        }
        finally {
            Release-ComRef -Reference ([ref]$color) -Label 'chart mutation color'
            Release-ComRef -Reference ([ref]$line) -Label 'chart mutation line'
            Release-ComRef -Reference ([ref]$fill) -Label 'chart mutation fill'
            Release-ComRef -Reference ([ref]$range2) -Label 'chart mutation text range'
            Release-ComRef -Reference ([ref]$frame2) -Label 'chart mutation text frame 2'
            Release-ComRef -Reference ([ref]$legacyFrame) -Label 'chart mutation legacy text frame'
            Release-ComRef -Reference ([ref]$targetShape) -Label 'chart mutation target shape'
            Release-ComRef -Reference ([ref]$secondShape) -Label 'chart mutation second shape'
            Release-ComRef -Reference ([ref]$firstShape) -Label 'chart mutation first shape'
            Release-ComRef -Reference ([ref]$groupItems) -Label 'chart mutation nested shapes'
            Release-ComRef -Reference ([ref]$groupShape) -Label 'chart mutation group shape'
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
$shapeTreeReceipts = [System.Collections.Generic.List[object]]::new()
$script:nativeChartMutationApplied = $false

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
    $validatedSpecJson = Get-WorkerPublicDrawingSpecJson -SpecJson $specJson
    $specObject = $validatedSpecJson | ConvertFrom-Json
    $specObject = Restore-WorkerEncodedStrings -Value $specObject
    Assert-WorkerDrawingSpecMetadata -SpecObject $specObject
    $skeletonBytes = [IO.File]::ReadAllBytes($skeletonPath)
    $stagedSkeletonSha256 = Get-BytesSha256 -Bytes $skeletonBytes
    $stageWidth = Get-WorkerSafeInteger `
        -Value $specObject.stage.width `
        -Path '$.stage.width'
    $stageHeight = Get-WorkerSafeInteger `
        -Value $specObject.stage.height `
        -Path '$.stage.height'
    if ($stageWidth -ne 960 -or $stageHeight -ne 540) {
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
    $allShapeNames = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    for ($slideIndex = 0; $slideIndex -lt $slidesSpec.Count; $slideIndex++) {
        $slideSpec = $slidesSpec[$slideIndex]
        $slidePath = "$.slides[$slideIndex]"
        Assert-WorkerSlideMetadata -Slide $slideSpec -Path $slidePath
        if (
            $slideSpec.id -cne $selectedSlideIds[$slideIndex] -or
            $slideSpec.family -cne $selectedSlideFamilies[$slideIndex]
        ) {
            throw "Drawing spec selected-slide metadata does not match slide $($slideIndex + 1)."
        }
        $primitives = @($slideSpec.primitives)
        $chartCount = 0
        for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
            $primitive = $primitives[$primitiveIndex]
            $primitivePath = "$slidePath.primitives[$primitiveIndex]"
            Assert-WorkerNonemptyString `
                -Value $primitive.kind `
                -Path "$primitivePath.kind"
            Assert-WorkerNonemptyString `
                -Value $primitive.role `
                -Path "$primitivePath.role"
            $kind = $primitive.kind
            if ($specObject.theme.unbranded -and $primitive.role -ceq 'wordmark') {
                throw "$primitivePath.role cannot emit a wordmark in an unbranded spec."
            }
            $primitiveZ = Get-WorkerSafeInteger `
                -Value $primitive.z `
                -Path "$primitivePath.z"
            if ($primitiveZ -ne $primitiveIndex + 1) {
                throw "Drawing spec primitive z-order is not contiguous at slide $($slideIndex + 1), primitive $($primitiveIndex + 1)."
            }
            Register-WorkerShapeName `
                -Value $primitive.name `
                -Path "$primitivePath.name" `
                -Names $allShapeNames
            if ($kind -ceq 'nativeChart') {
                $chartCount++
                Assert-NativeChartSpec `
                    -Primitive $primitive `
                    -Path $primitivePath `
                    -Theme $specObject.theme `
                    -Names $allShapeNames `
                    -SlideFamily $slideSpec.family `
                    -SlideEvidenceIds @($slideSpec.evidenceIds)
            }
            elseif ($kind -ceq 'text') {
                Assert-WorkerTextPrimitive `
                    -Primitive $primitive `
                    -Path $primitivePath `
                    -Theme $specObject.theme
            }
            elseif ($kind -ceq 'shape') {
                Assert-WorkerShapePrimitive `
                    -Primitive $primitive `
                    -Path $primitivePath `
                    -Theme $specObject.theme
            }
            elseif ($kind -ceq 'line') {
                Assert-WorkerLinePrimitive `
                    -Primitive $primitive `
                    -Path $primitivePath `
                    -Theme $specObject.theme
            }
            elseif ($kind -ceq 'table') {
                Assert-TablePrimitiveSpec `
                    -Primitive $primitive `
                    -SlideSpec $slideSpec `
                    -Theme $specObject.theme
            }
            else {
                throw "Unsupported primitive kind '$kind'. The PowerPoint worker supports text, shape, line, table, nativeChart, and workflow line connectors."
            }
        }
        if ($slideSpec.family -ceq 'workflow') {
            Assert-WorkerWorkflowSlideContract -Slide $slideSpec -Path $slidePath
        }
        if (
            ($slideSpec.family -ceq 'chart' -and $chartCount -ne 1) -or
            ($slideSpec.family -cne 'chart' -and $chartCount -ne 0)
        ) {
            throw "Drawing spec chart primitive count is invalid on slide $($slideIndex + 1)."
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
    $nativeChartMutationMode = [string]$env:FDE_POWERPOINT_TEST_MUTATE_NATIVE_CHART_AFTER_REOPEN
    if (-not [string]::IsNullOrWhiteSpace($nativeChartMutationMode)) {
        if ($env:FDE_POWERPOINT_TEST_FAILPOINTS -ne '1') {
            throw 'Native chart mutations require FDE_POWERPOINT_TEST_FAILPOINTS=1.'
        }
        if ($nativeChartMutationMode -notin @('geometry', 'content', 'style', 'nested-name', 'z-order', 'line-orientation')) {
            throw "Unsupported native chart mutation mode '$nativeChartMutationMode'."
        }
    }
    if ($ValidateSpecOnly) {
        $validationChartCount = 0
        $validationChartLeafCount = 0
        for ($slideIndex = 0; $slideIndex -lt $slidesSpec.Count; $slideIndex++) {
            $primitives = @($slidesSpec[$slideIndex].primitives)
            for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
                if ([string]$primitives[$primitiveIndex].kind -eq 'nativeChart') {
                    $validationChartCount++
                    $validationChartLeafCount += @(
                        Get-NativeChartLeafSpecs -Primitive $primitives[$primitiveIndex]
                    ).Count
                }
            }
        }
        $validationObject = [ordered]@{
            status = 'SPEC_VALID'
            specSha256 = $actualSpecSha256
            slideCount = $slidesSpec.Count
            nativeChartCount = $validationChartCount
            nativeChartLeafCount = $validationChartLeafCount
        }
        [Console]::Out.WriteLine(($validationObject | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        [Environment]::Exit(0)
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
                            'nativeChart' {
                                Add-NativeChartPrimitive -Shapes $shapes -Primitive $primitive -Theme $specObject.theme
                                Invoke-TestFailpoint -Stage 'native-chart'
                            }
                        }
                    }
                    catch {
                        throw "Slide $slideIndex primitive $($primitive.name) ($($primitive.kind)) failed: $($_.Exception.Message)"
                    }
                }
                Assert-NativeTables -Slide $slide -SlideSpec $slideSpec -Theme $specObject.theme
                [void](Assert-TextFits `
                    -Shapes $shapes `
                    -SlideSpec $slideSpec `
                    -Theme $specObject.theme `
                    -SlideIndex $slideIndex)
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
            $verificationShapes = $null
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
                Assert-NativeTables -Slide $slide -SlideSpec $slideSpec -Theme $specObject.theme
                $verificationShapes = $slide.Shapes
                if (-not [string]::IsNullOrWhiteSpace($nativeChartMutationMode)) {
                    Invoke-NativeChartTestMutation `
                        -Shapes $verificationShapes `
                        -SlideSpec $slideSpec `
                        -Mode $nativeChartMutationMode
                }
                $shapeTreeReceipt = Assert-TextFits `
                    -Shapes $verificationShapes `
                    -SlideSpec $slideSpec `
                    -Theme $specObject.theme `
                    -SlideIndex $slideIndex
                $shapeTreeReceipts.Add($shapeTreeReceipt)
                if (@($slideSpec.primitives).Where({ [string]$_.kind -eq 'nativeChart' }).Count -gt 0) {
                    Invoke-TestFailpoint -Stage 'chart-reopen'
                }
            }
            finally {
                Release-ComRef -Reference ([ref]$verificationShapes) -Label 'reopen verification shapes'
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
                $shapeTreeReceipt = $shapeTreeReceipts[$slideIndex - 1]
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
                    recursiveRecords = @($shapeTreeReceipt.recursiveRecords)
                    nativeChartRecords = @($shapeTreeReceipt.nativeChartRecords)
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
    $recursiveShapeCount = 0
    $nativeChartShapeCount = 0
    $recursiveShapeHashLines = [Collections.Generic.List[string]]::new()
    $finalSlideReports = [Collections.Generic.List[object]]::new()
    for ($slideIndex = 0; $slideIndex -lt $slideReports.Count; $slideIndex++) {
        $draft = $slideReports[$slideIndex]
        $recursiveRecords = @($draft.recursiveRecords)
        $nativeChartRecords = @($draft.nativeChartRecords)
        $nameLines = @($recursiveRecords | ForEach-Object { [string]$_.name })
        $geometryLines = @($recursiveRecords | ForEach-Object { "$($_.name)|$($_.geometry)" })
        $contentLines = @($recursiveRecords | ForEach-Object { "$($_.name)|$($_.content)" })
        $styleLines = @($recursiveRecords | ForEach-Object { "$($_.name)|$($_.style)" })
        $chartNameLines = @($nativeChartRecords | ForEach-Object { [string]$_.name })
        $recursiveNamesSha256 = Get-TextSha256 -Text ($nameLines -join "`n")
        $recursiveGeometrySha256 = Get-TextSha256 -Text ($geometryLines -join "`n")
        $recursiveContentSha256 = Get-TextSha256 -Text ($contentLines -join "`n")
        $recursiveStyleSha256 = Get-TextSha256 -Text ($styleLines -join "`n")
        $nativeChartNamesSha256 = Get-TextSha256 -Text ($chartNameLines -join "`n")
        $recursiveShapeCount += $recursiveRecords.Count
        $nativeChartShapeCount += $nativeChartRecords.Count
        $recursiveShapeHashLines.Add(
            "$($draft.id)|$recursiveNamesSha256|$recursiveGeometrySha256|$recursiveContentSha256|$recursiveStyleSha256"
        )
        $finalSlideReports.Add([pscustomobject][ordered]@{
            index = $draft.index
            id = $draft.id
            family = $draft.family
            backgroundColorRole = $draft.backgroundColorRole
            primitiveCount = $draft.primitiveCount
            primitiveSha256 = $draft.primitiveSha256
            shapeCount = $draft.shapeCount
            shapeNamesSha256 = $draft.shapeNamesSha256
            recursiveShapeCount = $recursiveRecords.Count
            recursiveShapeNamesSha256 = $recursiveNamesSha256
            recursiveShapeGeometrySha256 = $recursiveGeometrySha256
            recursiveShapeContentSha256 = $recursiveContentSha256
            recursiveShapeStyleSha256 = $recursiveStyleSha256
            nativeChartShapeCount = $nativeChartRecords.Count
            nativeChartShapeNamesSha256 = $nativeChartNamesSha256
            nativeTableCount = $draft.nativeTableCount
            nativeTableCellCount = $draft.nativeTableCellCount
            connectorRouteCount = $draft.connectorRouteCount
            connectorSegmentCount = $draft.connectorSegmentCount
            connectorPrimitiveSha256 = $draft.connectorPrimitiveSha256
            connectorRouteMetadataSha256 = $draft.connectorRouteMetadataSha256
            connectorPointSequenceSha256 = $draft.connectorPointSequenceSha256
            connectorCostStatus = $draft.connectorCostStatus
            render = $draft.render
            renderSha256 = $draft.renderSha256
            notesSha256 = $draft.notesSha256
            overflow = $draft.overflow
        })
    }
    $nativeShapesReceipt = [pscustomobject][ordered]@{
        recursiveShapeCount = $recursiveShapeCount
        nativeChartShapeCount = $nativeChartShapeCount
        recursiveShapeTreeSha256 = Get-TextSha256 -Text ($recursiveShapeHashLines -join "`n")
    }
    $reportObject = [ordered]@{
        status = 'WORKER_PASS'
        stagingEvidence = $true
        worker = 'fde-powerpoint-native-shapes/2.0'
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
        slides = $finalSlideReports.ToArray()
        nativeShapes = $nativeShapesReceipt
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
