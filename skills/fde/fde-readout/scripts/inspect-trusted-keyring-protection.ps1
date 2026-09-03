[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$programDataPath = [IO.Path]::GetFullPath('C:\ProgramData')
$keyringPath = [IO.Path]::GetFullPath(
    'C:\ProgramData\GitHub\Copilot\FdeReadout\trusted-ed25519-keyring.json'
)
$paths = @(
    'C:\ProgramData\GitHub',
    'C:\ProgramData\GitHub\Copilot',
    'C:\ProgramData\GitHub\Copilot\FdeReadout',
    $keyringPath
)
$trustedOwnerSids = @(
    'S-1-5-18',
    'S-1-5-32-544'
)
$unsafeRightsMask = [int64]2 -bor
    [int64]4 -bor
    [int64]16 -bor
    [int64]64 -bor
    [int64]256 -bor
    [int64]65536 -bor
    [int64]262144 -bor
    [int64]524288 -bor
    [int64]268435456 -bor
    [int64]1073741824

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
$explicitUntrustedSids = @(
    'S-1-1-0',
    'S-1-5-11',
    'S-1-5-32-545'
)
if (-not $isAdministrator) {
    $explicitUntrustedSids += $identity.User.Value
}

function ConvertTo-Sid {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Principal.IdentityReference]$IdentityReference
    )

    if ($IdentityReference -is [Security.Principal.SecurityIdentifier]) {
        return $IdentityReference.Value
    }
    return $IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
    ).Value
}

$entries = @()
for ($index = 0; $index -lt $paths.Count; $index++) {
    $path = [IO.Path]::GetFullPath($paths[$index])
    $expectedType = if ($index -eq ($paths.Count - 1)) { 'file' } else { 'directory' }
    $entry = [ordered]@{
        path = $path
        type = $expectedType
        exists = $false
        reparsePoint = $null
        ownerSid = $null
        ownerTrusted = $false
        unsafeAclEntries = @()
        inspectionError = $null
    }
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $entry.exists = $true
        $entry.type = if ($item.PSIsContainer) { 'directory' } else { 'file' }
        $entry.reparsePoint = (
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        )

        $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
        $ownerReference = [Security.Principal.NTAccount]::new($acl.Owner)
        $entry.ownerSid = ConvertTo-Sid -IdentityReference $ownerReference
        $entry.ownerTrusted = $trustedOwnerSids -contains $entry.ownerSid

        $unsafeAclEntries = @()
        foreach ($ace in @($acl.Access)) {
            $aceSid = ConvertTo-Sid -IdentityReference $ace.IdentityReference
            $rights = [int64]$ace.FileSystemRights
            $untrustedWriter = (
                $explicitUntrustedSids -contains $aceSid -or
                $trustedOwnerSids -notcontains $aceSid
            )
            if (
                $ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $untrustedWriter -and
                ($rights -band $unsafeRightsMask) -ne 0
            ) {
                $unsafeAclEntries += [ordered]@{
                    sid = $aceSid
                    rights = [string]$ace.FileSystemRights
                    inherited = [bool]$ace.IsInherited
                }
            }
        }
        $entry.unsafeAclEntries = @($unsafeAclEntries)
    }
    catch {
        $entry.inspectionError = $_.Exception.Message
    }
    $entries += [pscustomobject]$entry
}

$protected = $entries.Count -eq $paths.Count
foreach ($entry in $entries) {
    if (
        $entry.exists -ne $true -or
        $entry.reparsePoint -ne $false -or
        $entry.ownerTrusted -ne $true -or
        @($entry.unsafeAclEntries).Count -ne 0 -or
        $null -ne $entry.inspectionError
    ) {
        $protected = $false
    }
}

[Console]::Out.WriteLine((([ordered]@{
    schemaVersion = 1
    status = if ($protected) { 'PROTECTED' } else { 'UNPROTECTED' }
    programDataPath = $programDataPath
    keyringPath = $keyringPath
    invokingUserSid = $identity.User.Value
    invokingUserIsAdministrator = [bool]$isAdministrator
    entries = @($entries)
}) | ConvertTo-Json -Depth 6 -Compress))
