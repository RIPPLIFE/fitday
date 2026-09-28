$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown"
  } |
  Sort-Object InterfaceAlias

if (-not $addresses) {
  Write-Host "No active LAN address found. Connect the computer to the phone hotspot first." -ForegroundColor Yellow
  exit 1
}

foreach ($entry in $addresses) {
  $url = "http://$($entry.IPAddress):4173"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    $status = if ($response.StatusCode -eq 200) { "OK" } else { "HTTP $($response.StatusCode)" }
    Write-Host "$($entry.InterfaceAlias): $url  [$status]" -ForegroundColor Green
  } catch {
    Write-Host "$($entry.InterfaceAlias): $url  [not reachable]" -ForegroundColor Yellow
  }
}

$preferred = $addresses | Where-Object { $_.IPAddress -like "172.20.10.*" } | Select-Object -First 1
if ($preferred) {
  Write-Host ""
  Write-Host "Open this on the iPhone: http://$($preferred.IPAddress):4173" -ForegroundColor Cyan
}
