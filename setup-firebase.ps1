$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$keySource = Join-Path $env:USERPROFILE 'Downloads\keepfresh-c4e5b-firebase-adminsdk-fbsvc-dc43aab1e1.json'
$keyTarget = Join-Path $root 'server\firebase-service-account.json'
$envPath = Join-Path $root 'server\.env'
$examplePath = Join-Path $root 'server\.env.example'

if (-not (Test-Path -LiteralPath $keySource)) {
  throw "Could not find the Firebase key at $keySource. Download the service-account JSON and place it in your Downloads folder."
}
$serviceAccount = Get-Content -LiteralPath $keySource -Raw | ConvertFrom-Json
if ($serviceAccount.project_id -ne 'keepfresh-c4e5b') {
  throw "The selected key belongs to '$($serviceAccount.project_id)', not keepfresh-c4e5b."
}
Copy-Item -LiteralPath $keySource -Destination $keyTarget -Force

if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $examplePath -Destination $envPath
}
$content = Get-Content -LiteralPath $envPath -Raw
$settings = [ordered]@{
  DATABASE_PROVIDER = 'firebase'
  FIREBASE_PROJECT_ID = 'keepfresh-c4e5b'
  FIREBASE_SERVICE_ACCOUNT_FILE = 'server/firebase-service-account.json'
}
foreach ($setting in $settings.GetEnumerator()) {
  $pattern = '(?m)^' + [regex]::Escape($setting.Key) + '=.*$'
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace($content, $pattern, "$($setting.Key)=$($setting.Value)")
  } else {
    $content += "`r`n$($setting.Key)=$($setting.Value)"
  }
}
if ($content -match '(?m)^JWT_SECRET=change-me-to-a-long-random-string\s*$') {
  $jwt = node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))"
  $content = [regex]::Replace($content, '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$jwt")
}
if ($content -match '(?m)^ADMIN_PASSWORD=\s*$') {
  $content = [regex]::Replace($content, '(?m)^ADMIN_PASSWORD=.*$', 'ADMIN_PASSWORD=Keepfresh@2026')
}
[IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))

Write-Host 'Firebase key installed locally (not copied into the ZIP/repository).'
Write-Host 'Firestore project configured: keepfresh-c4e5b'
Write-Host 'The admin password is Keepfresh@2026 unless you already set a different one in server/.env.'
Write-Host 'Add your newly rotated EmailJS private key to server/.env before enabling signup email.'
Write-Host 'Next: npm run setup; npm run build; npm start'
