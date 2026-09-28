$source = Join-Path $PSScriptRoot "public"
$target = Join-Path $PSScriptRoot "docs"

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force
New-Item -ItemType File -Force -Path (Join-Path $target ".nojekyll") | Out-Null

Write-Host "Phone build synced to docs." -ForegroundColor Green
