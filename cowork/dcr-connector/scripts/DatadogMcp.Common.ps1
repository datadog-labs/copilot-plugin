Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DdOrigin = 'https://mcp.datadoghq.com'
$script:DdEndpoint = "$script:DdOrigin/v1/mcp"
$script:DdRegistration = "$script:DdOrigin/api/unstable/mcp-server/register"
$script:DdMode = 'plan'
$script:DdClient = $null
$script:DdFixture = $null

function Get-DdProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-DdEndpoint {
    param([string]$Url)
    return ($Url -cmatch '^https://mcp\.datadoghq\.com/v1/mcp(?:\?subdomain=(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9]))?$')
}

function Test-DdOriginUrl {
    param([string]$Url, [string]$PathPrefix = '/')
    if ([string]::IsNullOrWhiteSpace($Url) -or $Url -match '[\s\\]' -or
        $Url -match '(?i)%2f|%5c|%2e') { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $false }
    return ($uri.Scheme -ceq 'https' -and $uri.Authority -ceq 'mcp.datadoghq.com' -and
        $uri.UserInfo.Length -eq 0 -and
        ($uri.Query.Length -eq 0 -or (Test-DdEndpoint $Url)) -and
        $uri.Fragment.Length -eq 0 -and
        $uri.AbsolutePath.StartsWith($PathPrefix, [StringComparison]::Ordinal) -and
        $Url -notmatch '/\.\.?(/|$)')
}

function Initialize-DdTransport {
    param([switch]$Live, [string]$OfflineFixture, [int]$TimeoutSeconds)
    if ($Live -and $OfflineFixture) { throw 'Choose live or fixture mode, not both.' }
    if ($OfflineFixture) {
        try {
            $item = Get-Item -LiteralPath $OfflineFixture -ErrorAction Stop
            if (-not $item.PSIsContainer -and $item.Length -le 65536) {
                $script:DdFixture = Get-Content -LiteralPath $OfflineFixture -Raw -Encoding UTF8 |
                    ConvertFrom-Json -ErrorAction Stop
            }
        } catch {
            throw 'Cannot read a valid offline fixture.'
        }
        if ($null -eq (Get-DdProperty $script:DdFixture 'responses')) {
            throw 'Offline fixture must contain responses.'
        }
        $script:DdMode = 'fixture'
        return
    }
    if ($Live) {
        Add-Type -AssemblyName System.Net.Http
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $handler.UseCookies = $false
        $handler.UseDefaultCredentials = $false
        $handler.PreAuthenticate = $false
        $script:DdClient = [System.Net.Http.HttpClient]::new($handler, $true)
        $script:DdClient.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
        $script:DdClient.MaxResponseContentBufferSize = 65536
        $script:DdMode = 'live'
    }
}

function Close-DdTransport {
    if ($null -ne $script:DdClient) {
        $script:DdClient.Dispose()
        $script:DdClient = $null
    }
}

function Invoke-DdRequest {
    param(
        [ValidateSet('GET', 'POST')][string]$Method,
        [string]$Url,
        [switch]$ReadBody,
        [string]$Payload
    )
    if (-not (Test-DdOriginUrl $Url)) { throw 'Blocked non-Datadog or unsafe URL.' }
    if ($Method -eq 'POST' -and $Url -cne $script:DdRegistration) {
        throw 'Unreviewed registration endpoint; no client was created.'
    }
    if ($script:DdMode -eq 'fixture') {
        $entry = Get-DdProperty (Get-DdProperty $script:DdFixture 'responses') "$Method $Url"
        if ($null -eq $entry) {
            return [pscustomobject]@{
                Status = $null; Outcome = 'fixture_unavailable'; Challenge = $null; Body = $null
            }
        }
        if ((Get-DdProperty $entry 'unreachable') -eq $true) {
            return [pscustomobject]@{
                Status = $null; Outcome = 'tool_unreachable'; Challenge = $null; Body = $null
            }
        }
        $status = Get-DdProperty $entry 'status'
        if ($null -eq $status -or [int]$status -lt 100 -or [int]$status -gt 599) {
            throw 'Invalid offline response status.'
        }
        return [pscustomobject]@{
            Status = [int]$status
            Outcome = 'http_response'
            Challenge = Get-DdProperty $entry 'wwwAuthenticate'
            Body = Get-DdProperty $entry 'body'
        }
    }
    if ($script:DdMode -ne 'live') { throw 'No network mode selected.' }

    $verb = if ($Method -eq 'POST') {
        [System.Net.Http.HttpMethod]::Post
    } else {
        [System.Net.Http.HttpMethod]::Get
    }
    $request = [System.Net.Http.HttpRequestMessage]::new($verb, [Uri]$Url)
    $response = $null
    try {
        $request.Headers.Accept.ParseAdd('application/json, text/event-stream')
        if ($Method -eq 'POST') {
            $request.Content = [System.Net.Http.StringContent]::new(
                $Payload, [Text.Encoding]::UTF8, 'application/json')
        }
        $completion = if ($ReadBody) {
            [System.Net.Http.HttpCompletionOption]::ResponseContentRead
        } else {
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        }
        $response = $script:DdClient.SendAsync($request, $completion).GetAwaiter().GetResult()
        $challenge = ($response.Headers.WwwAuthenticate | ForEach-Object { $_.ToString() }) -join ', '
        $body = $null
        if ($ReadBody -and $null -ne $response.Content -and
            [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            try {
                $body = $text | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $body = $null
            }
        }
        return [pscustomobject]@{
            Status = [int]$response.StatusCode
            Outcome = 'http_response'
            Challenge = $challenge
            Body = $body
        }
    } catch [System.Net.Http.HttpRequestException] {
        return [pscustomobject]@{
            Status = $null; Outcome = 'tool_unreachable'; Challenge = $null; Body = $null
        }
    } catch [System.Threading.Tasks.TaskCanceledException] {
        return [pscustomobject]@{
            Status = $null; Outcome = 'tool_unreachable'; Challenge = $null; Body = $null
        }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
    }
}

function Get-DdChallengeUrl {
    param([string]$Challenge)
    if ([string]::IsNullOrEmpty($Challenge)) { return $null }
    $match = [regex]::Match($Challenge, '(?i)\bresource_metadata\s*=\s*"([^"]+)"')
    if (-not $match.Success) { return $null }
    $url = $match.Groups[1].Value
    if (Test-DdOriginUrl $url '/.well-known/oauth-protected-resource') {
        return $url
    }
    return $null
}

function New-DdDiscoverySummary {
    return [ordered]@{
        mode = $script:DdMode
        mcp_probe_status = $null
        mcp_probe_outcome = 'not_run'
        protected_resource = 'inconclusive'
        protected_resource_probe = 'not_run'
        authorization_server = 'inconclusive'
        authorization_metadata_probe = 'not_run'
        registration_advertised = 'inconclusive'
        client_secret_issuance = 'inconclusive'
        authenticated_mcp = 'not_tested'
        reason = 'not_run'
    }
}

function Get-DdDiscovery {
    param([string]$Endpoint)
    if (-not (Test-DdEndpoint $Endpoint)) {
        throw 'Only the official US1 MCP endpoint and its one-label subdomain are supported.'
    }
    $summary = New-DdDiscoverySummary
    $result = [pscustomobject]@{ Summary = $summary; RegistrationUrl = $null }
    if ($script:DdMode -eq 'plan') { return $result }

    $probe = Invoke-DdRequest -Method GET -Url $Endpoint
    $summary.mcp_probe_status = $probe.Status
    $summary.mcp_probe_outcome = $probe.Outcome
    if ($probe.Outcome -eq 'http_response' -and
        $probe.Status -ge 300 -and $probe.Status -lt 400) {
        $summary.reason = 'redirect_blocked'
        return $result
    }
    $candidates = [System.Collections.Generic.List[string]]::new()
    $fromChallenge = Get-DdChallengeUrl $probe.Challenge
    if ($fromChallenge) { $candidates.Add($fromChallenge) }
    $candidates.Add("$script:DdOrigin/.well-known/oauth-protected-resource/v1/mcp")
    $candidates.Add("$script:DdOrigin/.well-known/oauth-protected-resource")
    $resource = $null
    $saw404 = $false
    $sawOtherHttp = $false
    $sawInvalid = $false
    $sawUnreachable = $false
    $sawFixtureGap = $false
    foreach ($url in ($candidates | Select-Object -Unique)) {
        $response = Invoke-DdRequest -Method GET -Url $url -ReadBody
        if ($response.Outcome -eq 'fixture_unavailable') {
            $sawFixtureGap = $true
            continue
        }
        if ($response.Outcome -eq 'tool_unreachable') {
            $sawUnreachable = $true
            continue
        }
        if ($response.Status -eq 200) {
            if ($null -ne $response.Body) {
                $resource = $response.Body
                break
            }
            $sawInvalid = $true
        } elseif ($response.Status -eq 404) {
            $saw404 = $true
        } else {
            $sawOtherHttp = $true
        }
    }
    if ($null -eq $resource) {
        if ($sawFixtureGap) {
            $summary.protected_resource_probe = 'fixture_unavailable'
            $summary.reason = 'protected_resource_fixture_unavailable'
        } elseif ($sawUnreachable) {
            $summary.protected_resource_probe = 'tool_unreachable'
            $summary.reason = 'protected_resource_probe_unreachable'
        } elseif ($sawOtherHttp) {
            $summary.protected_resource_probe = 'http_unavailable'
            $summary.reason = 'protected_resource_http_unavailable'
        } elseif ($sawInvalid) {
            $summary.protected_resource = 'fail'
            $summary.protected_resource_probe = 'invalid_document'
            $summary.reason = 'protected_resource_invalid_document'
        } elseif ($saw404) {
            $summary.protected_resource = 'fail'
            $summary.protected_resource_probe = 'missing_http_404'
            $summary.reason = 'protected_resource_missing_http_404'
        } else {
            $summary.reason = 'protected_resource_no_http_evidence'
        }
        return $result
    }
    $summary.protected_resource_probe = 'found'
    $expectedResource = $Endpoint.Split('?')[0]
    $authorizationServers = @(Get-DdProperty $resource 'authorization_servers')
    if ((Get-DdProperty $resource 'resource') -cne $expectedResource -or
        -not ($authorizationServers -ccontains $script:DdOrigin)) {
        $summary.protected_resource = 'fail'
        $summary.reason = 'protected_resource_mismatch'
        return $result
    }
    $summary.protected_resource = 'pass'

    $metadata = Invoke-DdRequest -Method GET -Url "$script:DdOrigin/.well-known/oauth-authorization-server" -ReadBody
    if ($metadata.Outcome -ne 'http_response') {
        $summary.authorization_metadata_probe = $metadata.Outcome
        $summary.reason = 'authorization_metadata_probe_unavailable'
        return $result
    }
    if ($metadata.Status -eq 404) {
        $summary.authorization_server = 'fail'
        $summary.authorization_metadata_probe = 'missing_http_404'
        $summary.reason = 'authorization_metadata_missing_http_404'
        return $result
    }
    if ($metadata.Status -ne 200) {
        $summary.authorization_metadata_probe = 'http_unavailable'
        $summary.reason = 'authorization_metadata_http_unavailable'
        return $result
    }
    if ($null -eq $metadata.Body) {
        $summary.authorization_server = 'fail'
        $summary.authorization_metadata_probe = 'invalid_document'
        $summary.reason = 'authorization_metadata_invalid_document'
        return $result
    }
    $summary.authorization_metadata_probe = 'found'
    $server = $metadata.Body
    $authorizationUrl = Get-DdProperty $server 'authorization_endpoint'
    $tokenUrl = Get-DdProperty $server 'token_endpoint'
    if ((Get-DdProperty $server 'issuer') -cne $script:DdOrigin -or
        -not (Test-DdOriginUrl $authorizationUrl) -or
        -not (Test-DdOriginUrl $tokenUrl) -or
        -not (@(Get-DdProperty $server 'code_challenge_methods_supported') -ccontains 'S256') -or
        -not (@(Get-DdProperty $server 'grant_types_supported') -ccontains 'authorization_code')) {
        $summary.authorization_server = 'fail'
        $summary.reason = 'authorization_metadata_invalid'
        return $result
    }
    $summary.authorization_server = 'pass'
    $registrationUrl = Get-DdProperty $server 'registration_endpoint'
    if (-not (Test-DdOriginUrl $registrationUrl)) {
        $summary.registration_advertised = 'fail'
        $summary.reason = 'registration_endpoint_missing_or_unsafe'
        return $result
    }
    if ($registrationUrl -cne $script:DdRegistration) {
        $summary.reason = 'registration_endpoint_requires_review'
        return $result
    }
    $methods = @(Get-DdProperty $server 'token_endpoint_auth_methods_supported')
    if (-not ($methods -ccontains 'client_secret_basic' -or
              $methods -ccontains 'client_secret_post')) {
        $summary.reason = 'client_secret_auth_not_advertised'
        return $result
    }
    $summary.registration_advertised = 'pass'
    $summary.reason = 'metadata_valid_secret_issuance_unverified'
    $result.RegistrationUrl = $registrationUrl
    return $result
}

function Get-DdExitCode {
    param([object]$Summary)
    if ($Summary.protected_resource -eq 'fail' -or
        $Summary.authorization_server -eq 'fail' -or
        $Summary.registration_advertised -eq 'fail' -or
        $Summary.client_secret_issuance -eq 'fail') { return 2 }
    if ($Summary.mcp_probe_outcome -eq 'http_response' -and
        $Summary.protected_resource -eq 'pass' -and
        $Summary.authorization_server -eq 'pass' -and
        $Summary.registration_advertised -eq 'pass') { return 0 }
    return 3
}
