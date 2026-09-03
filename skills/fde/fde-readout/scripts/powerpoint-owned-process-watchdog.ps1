[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ProcessStartTimeUtc,

    [Parameter(Mandatory = $true)]
    [string]$ProcessPath,

    [Parameter(Mandatory = $true)]
    [string]$Owner
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (
    $ProcessId -le 0 -or
    $Owner -notin @(
        'fde-powerpoint-skeleton/1.0',
        'fde-powerpoint-native-shapes/2.0'
    ) -or
    [string]::IsNullOrWhiteSpace($ProcessPath) -or
    [IO.Path]::GetFileName($ProcessPath) -ine 'POWERPNT.EXE'
) {
    throw 'Validated ownership identity fields are invalid.'
}

$expectedStart = [datetime]::MinValue
if (
    -not [datetime]::TryParseExact(
        $ProcessStartTimeUtc,
        'o',
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$expectedStart
    )
) {
    throw 'Validated processStartTimeUtc is invalid.'
}

$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
    [Console]::Out.WriteLine((([ordered]@{
        status = 'already-exited'
        processId = $processId
        processStartTimeUtc = $ProcessStartTimeUtc
        processPath = [IO.Path]::GetFullPath($ProcessPath)
        owner = $Owner
        exactIdentity = $true
        exited = $true
        mode = 'none'
    }) | ConvertTo-Json -Compress))
    exit 0
}

$actualPath = $process.Path
$actualStart = $process.StartTime.ToUniversalTime()
if (
    [string]::IsNullOrWhiteSpace($actualPath) -or
    -not [string]::Equals(
        [IO.Path]::GetFullPath($actualPath),
        [IO.Path]::GetFullPath($ProcessPath),
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    $actualStart.Ticks -ne $expectedStart.ToUniversalTime().Ticks
) {
    throw "PID $processId does not match the exact owned PowerPoint identity."
}

$mode = 'graceful'
if (-not $process.HasExited) {
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(5000)) {
        $mode = 'forced'
        $process.Kill()
        if (-not $process.WaitForExit(5000)) {
            throw "Exact owned PowerPoint process PID $processId did not exit."
        }
    }
}

[Console]::Out.WriteLine((([ordered]@{
    status = 'cleaned'
    processId = $processId
    processStartTimeUtc = $ProcessStartTimeUtc
    processPath = [IO.Path]::GetFullPath($ProcessPath)
    owner = $Owner
    exactIdentity = $true
    exited = $process.HasExited
    mode = $mode
}) | ConvertTo-Json -Compress))
