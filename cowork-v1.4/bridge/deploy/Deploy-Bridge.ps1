<#
.SYNOPSIS
  Build the Datadog OAuth bridge image in Azure Container Registry and run it on Azure Container Apps.

.DESCRIPTION
  First run creates the container app with:
    - external HTTPS ingress on port 8080 (the bridge's public origin becomes PUBLIC_BASE_URL)
    - exactly one replica (authorization-code replay protection is in memory)
    - BRIDGE_SECRET generated here with a CSPRNG and stored only as a Container Apps secret
  Later runs only roll the image; the secret, and therefore every issued client and refresh token, is kept.
  Nothing secret is printed or written to disk.

.EXAMPLE
  ./Deploy-Bridge.ps1 -SubscriptionId <sub> -ResourceGroup rg-app -ContainerAppsEnvironment cae-app -AcrName myacr `
    -RegistryIdentity /subscriptions/<sub>/resourceGroups/rg-app/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-acrpull
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $ContainerAppsEnvironment,
  [Parameter(Mandatory)] [string] $AcrName,
  [string] $AppName = 'datadog-cowork-bridge',
  [string] $DatadogSite = 'datadoghq.com',
  [string] $UpstreamScope = 'mcp_read',
  # Resource ID of a user-assigned identity with AcrPull on the registry; omit to use the system identity.
  [string] $RegistryIdentity = 'system',
  [string] $ImageTag
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Az {
  $out = & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)" }
  $out
}

$bridgeDir = Split-Path -Parent $PSScriptRoot
if (-not $ImageTag) {
  $sha = (& git -C $bridgeDir rev-parse --short HEAD 2>$null)
  $ImageTag = if ($LASTEXITCODE -eq 0 -and $sha) { "$sha-$(Get-Date -Format yyyyMMddHHmmss)" } else { Get-Date -Format yyyyMMddHHmmss }
}

Invoke-Az account set --subscription $SubscriptionId | Out-Null
$domain = Invoke-Az containerapp env show -g $ResourceGroup -n $ContainerAppsEnvironment --query properties.defaultDomain -o tsv
$envId = Invoke-Az containerapp env show -g $ResourceGroup -n $ContainerAppsEnvironment --query id -o tsv
$loginServer = Invoke-Az acr show -n $AcrName --query loginServer -o tsv
$image = "$loginServer/datadog-cowork-bridge:$ImageTag"
$baseUrl = "https://$AppName.$domain"

if ($PSCmdlet.ShouldProcess($image, 'az acr build')) {
  Invoke-Az acr build --registry $AcrName --image "datadog-cowork-bridge:$ImageTag" $bridgeDir --only-show-errors | Out-Null
}

$exists = $false
& az containerapp show -g $ResourceGroup -n $AppName --query name -o tsv 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $exists = $true }

if (-not $exists) {
  if ($PSCmdlet.ShouldProcess($AppName, 'az containerapp create')) {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $identityArgs = @('--registry-server', $loginServer, '--registry-identity', $RegistryIdentity)
    if ($RegistryIdentity -ne 'system') { $identityArgs += @('--user-assigned', $RegistryIdentity) }
    Invoke-Az containerapp create -g $ResourceGroup -n $AppName --environment $envId --image $image `
      --ingress external --target-port 8080 --transport auto --min-replicas 1 --max-replicas 1 `
      --cpu 0.25 --memory 0.5Gi @identityArgs `
      --secrets "bridge-secret=$secret" `
      --env-vars "BRIDGE_SECRET=secretref:bridge-secret" "PUBLIC_BASE_URL=$baseUrl" "DD_SITE=$DatadogSite" "UPSTREAM_SCOPE=$UpstreamScope" `
      --only-show-errors -o none | Out-Null
    Remove-Variable secret, bytes
  }
} elseif ($PSCmdlet.ShouldProcess($AppName, 'az containerapp update (image only)')) {
  Invoke-Az containerapp update -g $ResourceGroup -n $AppName --image $image --only-show-errors -o none | Out-Null
}

$fqdn = Invoke-Az containerapp show -g $ResourceGroup -n $AppName --query properties.configuration.ingress.fqdn -o tsv
if ("https://$fqdn" -ne $baseUrl) { Write-Warning "Ingress FQDN $fqdn differs from PUBLIC_BASE_URL $baseUrl; update PUBLIC_BASE_URL." }

Write-Host ''
Write-Host "Bridge base URL : $baseUrl"
Write-Host "MCP URL         : $baseUrl/mcp"
Write-Host "Image           : $image"
Write-Host ''
Write-Host 'Checks:'
Write-Host "  curl -s $baseUrl/healthz"
Write-Host "  curl -s $baseUrl/.well-known/oauth-protected-resource/mcp"
Write-Host "  curl -s $baseUrl/.well-known/oauth-authorization-server"
Write-Host "  curl -s -i -X POST $baseUrl/mcp   # expect 401 with WWW-Authenticate: Bearer resource_metadata=..."
