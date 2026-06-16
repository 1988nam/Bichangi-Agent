param(
  [string[]]$Names = @(
    "KAKAO_WEBHOOK_URL",
    "KAKAO_REST_API_KEY",
    "KAKAO_CLIENT_SECRET",
    "KAKAO_REFRESH_TOKEN",
    "GOOGLE_DRIVE_REPORT_ENDPOINT",
    "GOOGLE_CALENDAR_ENDPOINT",
    "NEWS_RSS_URLS",
    "NEWS_SEARCH_ENDPOINT"
  )
)

$ErrorActionPreference = "Stop"
$env:XDG_CONFIG_HOME = Join-Path (Get-Location) ".wrangler-config"

foreach ($name in $Names) {
  Write-Host ""
  Write-Host "Setting Cloudflare secret: $name"
  npx wrangler secret put $name
}
