Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ConnectorRolePattern = '^workflow-edge-(system|decision)-(\d{2})$'
$script:ConnectorKeys = @(
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
    'arrowEnd',
    'sourceNodeId',
    'targetNodeId',
    'edgeIndex',
    'segmentIndex'
)
$script:WorkflowStage = [ordered]@{
    left = 48.0
    top = 116.0
    right = 912.0
    bottom = 478.0
}

function Get-ConnectorTextSha256 {
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

function ConvertTo-ConnectorHash {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        $Value
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 30 -Compress
    return Get-ConnectorTextSha256 -Text $json
}

function Test-ConnectorNumber {
    param($Value)

    if (
        $Value -isnot [byte] -and
        $Value -isnot [sbyte] -and
        $Value -isnot [int16] -and
        $Value -isnot [uint16] -and
        $Value -isnot [int32] -and
        $Value -isnot [uint32] -and
        $Value -isnot [int64] -and
        $Value -isnot [uint64] -and
        $Value -isnot [single] -and
        $Value -isnot [double] -and
        $Value -isnot [decimal]
    ) {
        return $false
    }
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
}

function Test-ConnectorInteger {
    param($Value)

    if (-not (Test-ConnectorNumber -Value $Value)) {
        return $false
    }
    $number = [double]$Value
    return (
        $number -eq [math]::Floor($number) -and
        $number -ge [int]::MinValue -and
        $number -le [int]::MaxValue
    )
}

function Assert-ConnectorCondition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw "Workflow connector validation failed: $Message"
    }
}

function Get-ConnectorProperties {
    param([Parameter(Mandatory = $true)]$Value)

    if ($null -eq $Value -or $Value -isnot [psobject]) {
        return @()
    }
    return @($Value.PSObject.Properties | ForEach-Object { $_.Name })
}

function Test-ConnectorProperty {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    return @(
        $Value.PSObject.Properties | Where-Object {
            [string]$_.Name -ceq $Name
        }
    ).Count -eq 1
}

function Assert-ConnectorExactKeys {
    param(
        [Parameter(Mandatory = $true)]$Primitive,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $actual = @(Get-ConnectorProperties -Value $Primitive)
    Assert-ConnectorCondition `
        -Condition ($actual.Count -eq $script:ConnectorKeys.Count) `
        -Message "$Path must use the exact workflow line primitive fields."
    foreach ($key in $script:ConnectorKeys) {
        Assert-ConnectorCondition `
            -Condition ($actual -ccontains $key) `
            -Message "$Path is missing required field '$key'."
    }
}

function Test-WorkflowConnectorPrimitive {
    param([Parameter(Mandatory = $true)]$Primitive)

    if ($null -eq $Primitive -or -not (Test-ConnectorProperty -Value $Primitive -Name 'role')) {
        return $false
    }
    return [string]$Primitive.role -clike 'workflow-edge-*'
}

function Test-WorkflowNodePrimitive {
    param([Parameter(Mandatory = $true)]$Primitive)

    if ($null -eq $Primitive -or -not (Test-ConnectorProperty -Value $Primitive -Name 'role')) {
        return $false
    }
    return (
        [string]$Primitive.role -clike 'workflow-node-*' -and
        [string]$Primitive.kind -ceq 'shape'
    )
}

function Test-ConnectorPointInStage {
    param(
        [Parameter(Mandatory = $true)]$X,
        [Parameter(Mandatory = $true)]$Y
    )

    return (
        [double]$X -ge $script:WorkflowStage.left -and
        [double]$X -le $script:WorkflowStage.right -and
        [double]$Y -ge $script:WorkflowStage.top -and
        [double]$Y -le $script:WorkflowStage.bottom
    )
}

function Test-ConnectorAnchor {
    param(
        [Parameter(Mandatory = $true)]$X,
        [Parameter(Mandatory = $true)]$Y,
        [Parameter(Mandatory = $true)]$Node
    )

    $left = [double]$Node.x
    $top = [double]$Node.y
    $right = $left + [double]$Node.w
    $bottom = $top + [double]$Node.h
    $middleX = $left + [double]$Node.w / 2
    $middleY = $top + [double]$Node.h / 2
    return (
        ([double]$X -eq $left -and [double]$Y -eq $middleY) -or
        ([double]$X -eq $right -and [double]$Y -eq $middleY) -or
        ([double]$X -eq $middleX -and [double]$Y -eq $top) -or
        ([double]$X -eq $middleX -and [double]$Y -eq $bottom)
    )
}

function Test-ConnectorCrossesNodeInterior {
    param(
        [Parameter(Mandatory = $true)]$Segment,
        [Parameter(Mandatory = $true)]$Node
    )

    $left = [double]$Node.x
    $top = [double]$Node.y
    $right = $left + [double]$Node.w
    $bottom = $top + [double]$Node.h
    if ([double]$Segment.y1 -eq [double]$Segment.y2) {
        return (
            [double]$Segment.y1 -gt $top -and
            [double]$Segment.y1 -lt $bottom -and
            [math]::Max(
                [math]::Min([double]$Segment.x1, [double]$Segment.x2),
                $left
            ) -lt [math]::Min(
                [math]::Max([double]$Segment.x1, [double]$Segment.x2),
                $right
            )
        )
    }
    return (
        [double]$Segment.x1 -gt $left -and
        [double]$Segment.x1 -lt $right -and
        [math]::Max(
            [math]::Min([double]$Segment.y1, [double]$Segment.y2),
            $top
        ) -lt [math]::Min(
            [math]::Max([double]$Segment.y1, [double]$Segment.y2),
            $bottom
        )
    )
}

function Get-WorkflowConnectorSpecReport {
    param([Parameter(Mandatory = $true)]$SpecObject)

    Assert-ConnectorCondition `
        -Condition ($null -ne $SpecObject -and (Test-ConnectorProperty -Value $SpecObject -Name 'slides')) `
        -Message 'the drawing spec must contain slides.'

    $drawingNames = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $slideReports = [Collections.Generic.List[object]]::new()
    $allRouteMetadata = [Collections.Generic.List[object]]::new()
    $allPointSequences = [Collections.Generic.List[object]]::new()
    $allConnectorPrimitives = [Collections.Generic.List[object]]::new()
    $totalRouteCount = 0
    $totalSegmentCount = 0
    $slides = @($SpecObject.slides)

    for ($slideIndex = 0; $slideIndex -lt $slides.Count; $slideIndex++) {
        $slide = $slides[$slideIndex]
        $slidePath = "slides[$slideIndex]"
        Assert-ConnectorCondition `
            -Condition (Test-ConnectorProperty -Value $slide -Name 'primitives') `
            -Message "$slidePath must contain primitives."
        $primitives = @($slide.primitives)
        for ($primitiveIndex = 0; $primitiveIndex -lt $primitives.Count; $primitiveIndex++) {
            $primitive = $primitives[$primitiveIndex]
            $primitivePath = "$slidePath.primitives[$primitiveIndex]"
            Assert-ConnectorCondition `
                -Condition (Test-ConnectorProperty -Value $primitive -Name 'name') `
                -Message "$primitivePath must declare a name."
            $name = [string]$primitive.name
            Assert-ConnectorCondition `
                -Condition (
                    $name -cmatch '^fde-[a-z0-9]+(?:-[a-z0-9]+)*$' -and
                    $name.Length -le 120
                ) `
                -Message "$primitivePath must use a stable fde-* name."
            Assert-ConnectorCondition `
                -Condition ($drawingNames.Add($name)) `
                -Message "duplicate drawing name '$name'."
            Assert-ConnectorCondition `
                -Condition (
                    (Test-ConnectorProperty -Value $primitive -Name 'z') -and
                    (Test-ConnectorInteger -Value $primitive.z) -and
                    [int]$primitive.z -eq $primitiveIndex + 1
                ) `
                -Message "$primitivePath must use contiguous deterministic z-order."
            if (
                @(
                    'sourceNodeId',
                    'targetNodeId',
                    'edgeIndex',
                    'segmentIndex'
                ).Where({
                    (Get-ConnectorProperties -Value $primitive) -ccontains $_
                }).Count -gt 0 -and
                -not (Test-WorkflowConnectorPrimitive -Primitive $primitive)
            ) {
                throw "Workflow connector validation failed: $primitivePath carries connector metadata without a workflow-edge role."
            }
        }

        $connectors = @(
            $primitives | Where-Object {
                Test-WorkflowConnectorPrimitive -Primitive $_
            }
        )
        $nodes = @(
            $primitives | Where-Object {
                Test-WorkflowNodePrimitive -Primitive $_
            }
        )
        $family = if (Test-ConnectorProperty -Value $slide -Name 'family') {
            [string]$slide.family
        }
        else {
            ''
        }
        if ($family -cne 'workflow') {
            Assert-ConnectorCondition `
                -Condition ($connectors.Count -eq 0) `
                -Message "$slidePath contains workflow connectors outside a workflow slide."
        }
        elseif ($connectors.Count -eq 0) {
            throw "Workflow connector validation failed: $slidePath has no workflow connector segments."
        }

        $nodeById = [Collections.Generic.Dictionary[string, object]]::new(
            [StringComparer]::Ordinal
        )
        $minimumNodeZ = [int]::MaxValue
        for ($nodeIndex = 0; $nodeIndex -lt $nodes.Count; $nodeIndex++) {
            $node = $nodes[$nodeIndex]
            Assert-ConnectorCondition `
                -Condition (
                    (Test-ConnectorProperty -Value $node -Name 'nodeId') -and
                    -not [string]::IsNullOrWhiteSpace([string]$node.nodeId)
                ) `
                -Message "$slidePath workflow node $nodeIndex must declare nodeId."
            $nodeId = [string]$node.nodeId
            Assert-ConnectorCondition `
                -Condition (-not $nodeById.ContainsKey($nodeId)) `
                -Message "$slidePath repeats workflow nodeId '$nodeId'."
            foreach ($key in @('x', 'y', 'w', 'h')) {
                Assert-ConnectorCondition `
                    -Condition (
                        (Test-ConnectorProperty -Value $node -Name $key) -and
                        (Test-ConnectorNumber -Value $node.$key)
                    ) `
                    -Message "$slidePath workflow node '$nodeId' has invalid $key."
            }
            Assert-ConnectorCondition `
                -Condition ([double]$node.w -gt 0 -and [double]$node.h -gt 0) `
                -Message "$slidePath workflow node '$nodeId' must have positive geometry."
            $nodeById[$nodeId] = $node
            $minimumNodeZ = [math]::Min($minimumNodeZ, [int]$node.z)
        }

        $connectorByEdge = [ordered]@{}
        for ($connectorIndex = 0; $connectorIndex -lt $connectors.Count; $connectorIndex++) {
            $connector = $connectors[$connectorIndex]
            $path = "$slidePath workflow connector segment $($connectorIndex + 1)"
            Assert-ConnectorExactKeys -Primitive $connector -Path $path
            Assert-ConnectorCondition `
                -Condition ([string]$connector.kind -ceq 'line') `
                -Message "$path must retain drawing-spec kind 'line'."
            $match = [regex]::Match([string]$connector.role, $script:ConnectorRolePattern)
            Assert-ConnectorCondition `
                -Condition $match.Success `
                -Message "$path has malformed role '$($connector.role)'."
            $kind = $match.Groups[1].Value
            $declaredEdgeIndex = [int]$match.Groups[2].Value
            Assert-ConnectorCondition `
                -Condition (
                    (Test-ConnectorInteger -Value $connector.edgeIndex) -and
                    [int]$connector.edgeIndex -gt 0 -and
                    [int]$connector.edgeIndex -eq $declaredEdgeIndex -and
                    (Test-ConnectorInteger -Value $connector.segmentIndex) -and
                    [int]$connector.segmentIndex -gt 0
                ) `
                -Message "$path has malformed edge or segment indexes."
            foreach ($key in @('x1', 'y1', 'x2', 'y2', 'width', 'transparency')) {
                Assert-ConnectorCondition `
                    -Condition (Test-ConnectorNumber -Value $connector.$key) `
                    -Message "$path has non-finite $key."
            }
            $horizontal = [double]$connector.y1 -eq [double]$connector.y2
            $vertical = [double]$connector.x1 -eq [double]$connector.x2
            Assert-ConnectorCondition `
                -Condition ($horizontal -xor $vertical) `
                -Message "$path must be nonzero and orthogonal."
            Assert-ConnectorCondition `
                -Condition (
                    (Test-ConnectorPointInStage -X $connector.x1 -Y $connector.y1) -and
                    (Test-ConnectorPointInStage -X $connector.x2 -Y $connector.y2)
                ) `
                -Message "$path escapes the workflow stage."
            Assert-ConnectorCondition `
                -Condition (
                    [string]$connector.colorRole -ceq $kind -and
                    [double]$connector.transparency -eq 0 -and
                    [double]$connector.width -eq $(if ($kind -ceq 'decision') { 1.5 } else { 1.0 }) -and
                    [string]$connector.dash -ceq 'solid' -and
                    [string]$connector.arrowStart -ceq 'none'
                ) `
                -Message "$path does not match semantic $kind style."
            Assert-ConnectorCondition `
                -Condition ([int]$connector.z -lt $minimumNodeZ) `
                -Message "$path must remain behind workflow nodes."
            $edgeKey = [string]$declaredEdgeIndex
            if (-not $connectorByEdge.Contains($edgeKey)) {
                $connectorByEdge[$edgeKey] = [Collections.Generic.List[object]]::new()
            }
            $connectorByEdge[$edgeKey].Add($connector)
            $allConnectorPrimitives.Add([ordered]@{
                name = [string]$connector.name
                role = [string]$connector.role
                z = [int]$connector.z
                x1 = $connector.x1
                y1 = $connector.y1
                x2 = $connector.x2
                y2 = $connector.y2
                colorRole = [string]$connector.colorRole
                transparency = $connector.transparency
                width = $connector.width
                dash = [string]$connector.dash
                arrowStart = [string]$connector.arrowStart
                arrowEnd = [string]$connector.arrowEnd
                sourceNodeId = [string]$connector.sourceNodeId
                targetNodeId = [string]$connector.targetNodeId
                edgeIndex = [int]$connector.edgeIndex
                segmentIndex = [int]$connector.segmentIndex
            })
        }

        $routeReports = [Collections.Generic.List[object]]::new()
        $edgeKeys = @($connectorByEdge.Keys | ForEach-Object { [int]$_ } | Sort-Object)
        if ($connectors.Count -gt 0) {
            Assert-ConnectorCondition `
                -Condition ($edgeKeys.Count -ge 2 -and $edgeKeys.Count -le 10) `
                -Message "$slidePath must contain 2-10 workflow routes."
        }
        for ($edgeOffset = 0; $edgeOffset -lt $edgeKeys.Count; $edgeOffset++) {
            $edgeIndex = $edgeKeys[$edgeOffset]
            Assert-ConnectorCondition `
                -Condition ($edgeIndex -eq $edgeOffset + 1) `
                -Message "$slidePath workflow route indexes must be contiguous from 1."
            $segments = @($connectorByEdge[[string]$edgeIndex])
            $first = $segments[0]
            $kind = [regex]::Match(
                [string]$first.role,
                $script:ConnectorRolePattern
            ).Groups[1].Value
            $sourceNodeId = [string]$first.sourceNodeId
            $targetNodeId = [string]$first.targetNodeId
            Assert-ConnectorCondition `
                -Condition (
                    $nodeById.ContainsKey($sourceNodeId) -and
                    $nodeById.ContainsKey($targetNodeId)
                ) `
                -Message "$slidePath route $edgeIndex references an unknown node."
            $points = [Collections.Generic.List[object]]::new()
            $points.Add([ordered]@{ x = $first.x1; y = $first.y1 })
            for ($segmentOffset = 0; $segmentOffset -lt $segments.Count; $segmentOffset++) {
                $segment = $segments[$segmentOffset]
                Assert-ConnectorCondition `
                    -Condition (
                        [int]$segment.segmentIndex -eq $segmentOffset + 1 -and
                        [string]$segment.sourceNodeId -ceq $sourceNodeId -and
                        [string]$segment.targetNodeId -ceq $targetNodeId -and
                        [string]$segment.role -ceq [string]$first.role
                    ) `
                    -Message "$slidePath route $edgeIndex metadata or point order is discontinuous."
                if ($segmentOffset -gt 0) {
                    $previous = $segments[$segmentOffset - 1]
                    Assert-ConnectorCondition `
                        -Condition (
                            [double]$previous.x2 -eq [double]$segment.x1 -and
                            [double]$previous.y2 -eq [double]$segment.y1
                        ) `
                        -Message "$slidePath route $edgeIndex does not share exact segment anchors."
                }
                $expectedArrowEnd = if ($segmentOffset -eq $segments.Count - 1) {
                    'open'
                }
                else {
                    'none'
                }
                Assert-ConnectorCondition `
                    -Condition ([string]$segment.arrowEnd -ceq $expectedArrowEnd) `
                    -Message "$slidePath route $edgeIndex has invalid arrow termination."
                foreach ($node in $nodes) {
                    Assert-ConnectorCondition `
                        -Condition (-not (Test-ConnectorCrossesNodeInterior -Segment $segment -Node $node)) `
                        -Message "$slidePath route $edgeIndex crosses node '$($node.nodeId)'."
                }
                $points.Add([ordered]@{ x = $segment.x2; y = $segment.y2 })
            }
            Assert-ConnectorCondition `
                -Condition (
                    (Test-ConnectorAnchor -X $first.x1 -Y $first.y1 -Node $nodeById[$sourceNodeId]) -and
                    (Test-ConnectorAnchor `
                        -X $segments[-1].x2 `
                        -Y $segments[-1].y2 `
                        -Node $nodeById[$targetNodeId])
                ) `
                -Message "$slidePath route $edgeIndex endpoints must use exact declared node anchors."

            $metadata = [ordered]@{
                edgeIndex = $edgeIndex
                kind = $kind
                sourceNodeId = $sourceNodeId
                targetNodeId = $targetNodeId
                segmentCount = $segments.Count
            }
            $pointSequence = [ordered]@{
                edgeIndex = $edgeIndex
                points = $points.ToArray()
            }
            $routeReport = [ordered]@{
                edgeIndex = $edgeIndex
                kind = $kind
                sourceNodeId = $sourceNodeId
                targetNodeId = $targetNodeId
                segmentCount = $segments.Count
                points = $points.ToArray()
                pointSequenceSha256 = ConvertTo-ConnectorHash -Value $pointSequence
                declaredCost = $null
                costStatus = 'not-declared-by-fde-drawing-spec/1.0'
            }
            $routeReports.Add([pscustomobject]$routeReport)
            $allRouteMetadata.Add([pscustomobject]$metadata)
            $allPointSequences.Add([pscustomobject]$pointSequence)
        }
        if ($connectors.Count -gt 0) {
            Assert-ConnectorCondition `
                -Condition (
                    @(
                        $routeReports | Where-Object {
                            [string]$_.kind -ceq 'decision'
                        }
                    ).Count -gt 0
                ) `
                -Message "$slidePath must contain a decision route."
        }

        $slideConnectorPrimitives = @(
            $connectors | ForEach-Object {
                [ordered]@{
                    name = [string]$_.name
                    role = [string]$_.role
                    z = [int]$_.z
                    x1 = $_.x1
                    y1 = $_.y1
                    x2 = $_.x2
                    y2 = $_.y2
                    colorRole = [string]$_.colorRole
                    transparency = $_.transparency
                    width = $_.width
                    dash = [string]$_.dash
                    arrowStart = [string]$_.arrowStart
                    arrowEnd = [string]$_.arrowEnd
                    sourceNodeId = [string]$_.sourceNodeId
                    targetNodeId = [string]$_.targetNodeId
                    edgeIndex = [int]$_.edgeIndex
                    segmentIndex = [int]$_.segmentIndex
                }
            }
        )
        $slideMetadata = @(
            $routeReports | ForEach-Object {
                [ordered]@{
                    edgeIndex = $_.edgeIndex
                    kind = $_.kind
                    sourceNodeId = $_.sourceNodeId
                    targetNodeId = $_.targetNodeId
                    segmentCount = $_.segmentCount
                }
            }
        )
        $slidePoints = @(
            $routeReports | ForEach-Object {
                [ordered]@{
                    edgeIndex = $_.edgeIndex
                    points = $_.points
                }
            }
        )
        $slideReports.Add([pscustomobject][ordered]@{
            index = $slideIndex + 1
            id = [string]$slide.id
            family = $family
            routeCount = $routeReports.Count
            segmentCount = $connectors.Count
            connectorPrimitiveSha256 = ConvertTo-ConnectorHash -Value $slideConnectorPrimitives
            routeMetadataSha256 = ConvertTo-ConnectorHash -Value $slideMetadata
            pointSequenceSha256 = ConvertTo-ConnectorHash -Value $slidePoints
            costStatus = 'not-declared-by-fde-drawing-spec/1.0'
            routes = $routeReports.ToArray()
        })
        $totalRouteCount += $routeReports.Count
        $totalSegmentCount += $connectors.Count
    }

    return [pscustomobject][ordered]@{
        drawingNameCount = $drawingNames.Count
        slideCount = $slides.Count
        routeCount = $totalRouteCount
        segmentCount = $totalSegmentCount
        connectorPrimitiveSha256 = ConvertTo-ConnectorHash -Value $allConnectorPrimitives.ToArray()
        routeMetadataSha256 = ConvertTo-ConnectorHash -Value $allRouteMetadata.ToArray()
        pointSequenceSha256 = ConvertTo-ConnectorHash -Value $allPointSequences.ToArray()
        costStatus = 'not-declared-by-fde-drawing-spec/1.0'
        slides = $slideReports.ToArray()
    }
}

Export-ModuleMember -Function @(
    'Get-WorkflowConnectorSpecReport',
    'Test-WorkflowConnectorPrimitive'
)
