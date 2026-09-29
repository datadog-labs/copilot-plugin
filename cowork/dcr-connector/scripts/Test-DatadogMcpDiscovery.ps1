# Read-only OAuth metadata diagnostic. No credentials or authenticated MCP calls.
[CmdletBinding()]
param(
    [switch]$Live,
    [string]$OfflineFixture,
    [string]$Endpoint = 'https://mcp.datadoghq.com/v1/mcp',
    [ValidateRange(1, 30)][int]$TimeoutSeconds = 10
)

. (Join-Path $PSScriptRoot 'DatadogMcp.Common.ps1')
try {
    Initialize-DdTransport -Live:$Live -OfflineFixture $OfflineFixture -TimeoutSeconds $TimeoutSeconds
    $result = Get-DdDiscovery -Endpoint $Endpoint
    $result.Summary | ConvertTo-Json -Depth 5
    exit (Get-DdExitCode $result.Summary)
} catch {
    [ordered]@{
        mode = $script:DdMode
        protected_resource = 'inconclusive'
        protected_resource_probe = 'not_run'
        authorization_server = 'inconclusive'
        authorization_metadata_probe = 'not_run'
        registration_advertised = 'inconclusive'
        client_secret_issuance = 'inconclusive'
        authenticated_mcp = 'not_tested'
        reason = 'local_or_network_error'
    } | ConvertTo-Json -Depth 5
    exit 3
} finally {
    Close-DdTransport
}
