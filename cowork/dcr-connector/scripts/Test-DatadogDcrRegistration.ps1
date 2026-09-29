# Creates at most one diagnostic OAuth client, only with explicit opt-in and ShouldProcess.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Live,
    [string]$OfflineFixture,
    [string]$Endpoint = 'https://mcp.datadoghq.com/v1/mcp',
    [ValidateRange(1, 30)][int]$TimeoutSeconds = 10,
    [switch]$RegisterClient,
    [string]$RedirectUri
)

. (Join-Path $PSScriptRoot 'DatadogMcp.Common.ps1')

function Test-DdRedirectUri {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\s\\]') { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { return $false }
    if ($uri.UserInfo.Length -gt 0 -or $uri.Fragment.Length -gt 0 -or
        $uri.Query.Length -gt 0) { return $false }
    if ($uri.Scheme -ceq 'https') { return $true }
    return ($uri.Scheme -ceq 'http' -and
        $uri.Host -cin @('127.0.0.1', 'localhost', '::1', '[::1]'))
}

try {
    if (-not $RegisterClient -or -not (Test-DdRedirectUri $RedirectUri)) {
        throw 'Registration requires explicit opt-in and an approved redirect URI.'
    }
    Initialize-DdTransport -Live:$Live -OfflineFixture $OfflineFixture -TimeoutSeconds $TimeoutSeconds
    $result = Get-DdDiscovery -Endpoint $Endpoint
    $summary = $result.Summary
    $summary['registration_http_status'] = $null
    $summary['registration_attempt'] = 'inconclusive'
    $summary['secret_issued'] = $null
    $summary['microsoft_token_store'] = 'not_tested'
    if ($summary.registration_advertised -ne 'pass' -or
        $summary.mcp_probe_outcome -ne 'http_response') {
        $summary | ConvertTo-Json -Depth 5
        exit (Get-DdExitCode $summary)
    }
    if (-not $PSCmdlet.ShouldProcess('Datadog DCR registration endpoint',
        'Create one diagnostic OAuth client; discard credentials')) {
        $summary.reason = 'registration_not_approved'
        $summary | ConvertTo-Json -Depth 5
        exit 3
    }
    $payload = @{
        client_name = 'Datadog MCP DCR compatibility diagnostic'
        redirect_uris = @($RedirectUri)
        grant_types = @('authorization_code', 'refresh_token')
        response_types = @('code')
        token_endpoint_auth_method = 'client_secret_basic'
    } | ConvertTo-Json -Depth 5 -Compress
    $response = Invoke-DdRequest -Method POST -Url $result.RegistrationUrl `
        -ReadBody -Payload $payload
    $summary.registration_http_status = $response.Status
    if ($response.Status -ge 200 -and $response.Status -lt 300) {
        $summary.registration_attempt = 'pass'
        $clientId = Get-DdProperty $response.Body 'client_id'
        $clientSecret = Get-DdProperty $response.Body 'client_secret'
        $summary.secret_issued = (-not [string]::IsNullOrWhiteSpace([string]$clientId) -and
            -not [string]::IsNullOrWhiteSpace([string]$clientSecret))
        $summary.client_secret_issuance = if ($summary.secret_issued) { 'pass' } else { 'fail' }
        $summary.reason = if ($summary.secret_issued) {
            'diagnostic_secret_issued_discarded'
        } else {
            'diagnostic_secret_not_issued'
        }
        $clientId = $null
        $clientSecret = $null
    } elseif ($response.Status -ge 400 -and $response.Status -lt 500) {
        $summary.registration_attempt = 'fail'
        $summary.reason = 'registration_rejected'
    } else {
        $summary.reason = 'registration_unavailable'
    }
    $summary | ConvertTo-Json -Depth 5
    if ($summary.registration_attempt -eq 'fail') { exit 2 }
    if ($summary.client_secret_issuance -eq 'inconclusive') { exit 3 }
    exit (Get-DdExitCode $summary)
} catch {
    [ordered]@{
        mode = $script:DdMode
        registration_advertised = 'inconclusive'
        client_secret_issuance = 'inconclusive'
        secret_issued = $null
        microsoft_token_store = 'not_tested'
        reason = 'local_or_network_error'
    } | ConvertTo-Json -Depth 5
    exit 3
} finally {
    Close-DdTransport
}
