# Pension dashboard - one-click data update
# Reads config\sources.json, downloads every source, keeps the last good copy
# when a download fails, then writes data\data.js for dashboard.html.
# (ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

$root   = Split-Path -Parent $PSScriptRoot
$rawDir = Join-Path $root 'data\raw'
New-Item -ItemType Directory -Force $rawDir | Out-Null
$utf8   = New-Object System.Text.UTF8Encoding($false)

function Read-Json($path) { $ser.DeserializeObject([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)) }

function Decode-Bytes([byte[]]$b) {
  $t = [Text.Encoding]::UTF8.GetString($b)
  if ($t.Contains([char]0xFFFD)) { $t = [Text.Encoding]::GetEncoding(950).GetString($b) }
  return $t.TrimStart([char]0xFEFF)
}

function Get-Bytes($url) {
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 90
  return ,$r.RawContentStream.ToArray()
}

function Test-Csv($text) {
  $t = $text.TrimStart()
  if ($t.Length -lt 10) { return $false }
  if ($t.StartsWith('<')) { return $false }   # HTML error / bot-check page
  return ($t.Split("`n")[0].Contains(','))
}

$cfg = Read-Json (Join-Path $root 'config\sources.json')
$results = New-Object System.Collections.ArrayList
$now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

function Save-Item($key, $id, $part, $text, $meta) {
  $base = Join-Path $rawDir ("{0}__{1}__{2}" -f $key, $id, $part)
  [IO.File]::WriteAllText("$base.csv", $text, $utf8)
  [IO.File]::WriteAllText("$base.meta.json", $ser.Serialize($meta), $utf8)
}

function Load-Item($key, $id, $part) {
  $base = Join-Path $rawDir ("{0}__{1}__{2}" -f $key, $id, $part)
  if (-not (Test-Path "$base.csv")) { return $null }
  $m = @{}
  if (Test-Path "$base.meta.json") { $m = Read-Json "$base.meta.json" }
  $m['csv'] = [IO.File]::ReadAllText("$base.csv", [Text.Encoding]::UTF8)
  return $m
}

# ---------- dataset discovery (new yearly datasets) ----------
# Uses the same search endpoint as the data.gov.tw search page.
function Find-Datasets($query, $pattern) {
  $q = $query.Replace('\', '\\').Replace('"', '\"')
  $json = '{"bool":[{"fulltext":{"value":"' + $q + '"}}],"filter":[],"page_num":1,"page_limit":50,"tids":[],"sort":"_score_desc"}'
  $r = Invoke-WebRequest -Uri 'https://data.gov.tw/api/front/dataset/list' -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 60
  $j = $ser.DeserializeObject((Decode-Bytes $r.RawContentStream.ToArray()))
  $found = @()
  foreach ($d in $j['payload']['search_result']) {
    $m = [regex]::Match([string]$d['title'], $pattern)
    if ($m.Success -and [string]$d['dataset_status_name'] -eq ([string][char]0x5DF2 + [char]0x4E0A + [char]0x67B6)) {  # "already published"
      $found += [pscustomobject]@{ id = [int]$d['nid']; year = [int]$m.Groups[1].Value; title = [string]$d['title'] }
    }
  }
  return $found
}
$discovery = @{}
foreach ($s in $cfg['datagov']) {
  if (-not $s['discover']) { continue }
  $ids = @($s['ids'] | ForEach-Object { [int]$_ })
  try {
    $found = Find-Datasets $s['discover']['query'] $s['discover']['pattern']
    $yearOf = @{}; foreach ($f in $found) { $yearOf[$f.id] = $f.year }
    $new = @($found | Where-Object { $ids -notcontains $_.id } | ForEach-Object { $_.id })
    $all = @($ids + $new)
    $s['ids'] = @($all | Sort-Object { if ($yearOf.ContainsKey($_)) { $yearOf[$_] } else { 0 } }, { [array]::IndexOf($all, $_) })
    $discovery[$s['key']] = @{ ok = $true; found = @($found | ForEach-Object { @{ id = $_.id; year = $_.year; title = $_.title } }); added = $new }
    Write-Host ("[search ] {0}: {1} dataset(s) found, new: {2}" -f $s['key'], $found.Count, ($(if ($new.Count) { $new -join ',' } else { 'none' })))
  } catch {
    $discovery[$s['key']] = @{ ok = $false; error = $_.Exception.Message; found = @(); added = @() }
    Write-Host ("[search ] {0}: search failed, using configured ids ({1})" -f $s['key'], $_.Exception.Message)
  }
}

# ---------- data.gov.tw ----------
foreach ($s in $cfg['datagov']) {
  foreach ($id in $s['ids']) {
    $title = ''; $modified = ''; $dists = @(); $apiErr = $null
    try {
      $j = $ser.DeserializeObject((Decode-Bytes (Get-Bytes "https://data.gov.tw/api/v2/rest/dataset/$id")))
      $res = $j['result']; $title = $res['title']; $modified = $res['modifiedDate']
      $dists = @($res['distribution'] | Where-Object { $_['resourceFormat'] -eq 'CSV' })
    } catch { $apiErr = $_.Exception.Message }
    foreach ($p in $s['parts']) {
      $status = 'ok'; $err = $null
      try {
        if ($apiErr) { throw "data.gov.tw API: $apiErr" }
        if ($p -ge $dists.Count) { throw "CSV part $p not found" }
        $srcUrl = [string]$dists[$p]['resourceDownloadUrl']; $via = 'source'
        $text = ''
        try { $text = Decode-Bytes (Get-Bytes $srcUrl) } catch { $text = '' }
        if (-not (Test-Csv $text)) {
          # Agency site blocked or down: fall back to data.gov.tw's own converted copy (not real-time).
          $md5 = [Security.Cryptography.MD5]::Create()
          $h = ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($srcUrl)) | ForEach-Object { $_.ToString('x2') }) -join ''
          $text = Decode-Bytes (Get-Bytes "https://quality.data.gov.tw/dq_download_csv.php?nid=$id&md5_url=$h")
          $via = 'mirror'
        }
        if (-not (Test-Csv $text)) { throw 'downloaded content is not CSV (agency site and data.gov.tw copy)' }
        if ($s['accumulate']) {
          # source only publishes the latest period: merge with the rows kept from earlier runs
          $old = Load-Item $s['key'] $id $p
          if ($old -and $old['csv']) {
            $newLines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
            $oldLines = @($old['csv'] -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
            $seen = @{}; $merged = New-Object System.Collections.Generic.List[string]
            $merged.Add($newLines[0])
            foreach ($ln in ($oldLines | Select-Object -Skip 1) + ($newLines | Select-Object -Skip 1)) { if (-not $seen.ContainsKey($ln)) { $seen[$ln] = 1; $merged.Add($ln) } }
            $text = ($merged -join "`r`n") + "`r`n"
          }
        }
        Save-Item $s['key'] $id $p $text @{ title = [string]$title; modified = [string]$modified; fetchedAt = $now; part = [string]$dists[$p]['resourceDescription']; via = $via }
      } catch {
        $err = $_.Exception.Message
        $status = if (Load-Item $s['key'] $id $p) { 'cached' } else { 'missing' }
      }
      [void]$results.Add([pscustomobject]@{ key = $s['key']; id = "$id"; part = $p; status = $status; error = $err })
      Write-Host ("[{0,-7}] {1} #{2}/{3} {4}" -f $status, $s['key'], $id, $p, $err)
    }
  }
}

# ---------- OECD (rate-limited API: few calls, spaced out) ----------
$first = $true
foreach ($s in $cfg['oecd']) {
  if (-not $first) { Start-Sleep -Seconds 3 }; $first = $false
  $status = 'ok'; $err = $null
  try {
    $text = Decode-Bytes (Get-Bytes $s['url'])
    if (-not $text.StartsWith('STRUCTURE')) { throw 'unexpected OECD response' }
    Save-Item $s['key'] 'oecd' 0 $text @{ title = [string]$s['label']; modified = ''; fetchedAt = $now; part = '' }
  } catch {
    $err = $_.Exception.Message
    $status = if (Load-Item $s['key'] 'oecd' 0) { 'cached' } else { 'missing' }
  }
  [void]$results.Add([pscustomobject]@{ key = $s['key']; id = 'oecd'; part = 0; status = $status; error = $err })
  Write-Host ("[{0,-7}] {1} {2}" -f $status, $s['key'], $err)
}

# ---------- build data\data.js ----------
$out = @{ generatedAt = $now; repo = [string]$cfg['repo']; sources = @{}; manual = (Read-Json (Join-Path $root 'config\manual.json')) }
$all = @()
foreach ($s in $cfg['datagov']) { foreach ($id in $s['ids']) { foreach ($p in $s['parts']) { $all += ,@($s['key'], $s['label'], "$id", $p, 'datagov') } } }
foreach ($s in $cfg['oecd']) { $all += ,@($s['key'], $s['label'], 'oecd', 0, 'oecd') }
foreach ($a in $all) {
  $key = [string]$a[0]; $aid = [string]$a[2]; $apart = [int]$a[3]
  if (-not $out.sources.ContainsKey($key)) { $out.sources[$key] = @{ label = [string]$a[1]; type = [string]$a[4]; items = [System.Collections.ArrayList]::new() } }
  if ($discovery.ContainsKey($key) -and -not $out.sources[$key].ContainsKey('discover')) {
    $dc = $cfg['datagov'] | Where-Object { $_['key'] -eq $key } | Select-Object -First 1
    $out.sources[$key]['discover'] = @{ query = [string]$dc['discover']['query']; ok = $discovery[$key].ok; error = [string]$discovery[$key].error;
      found = [System.Collections.ArrayList]::new(); added = [System.Collections.ArrayList]::new() }
    foreach ($f in $discovery[$key].found) { [void]$out.sources[$key]['discover'].found.Add(@{ id = [int]$f.id; year = [int]$f.year; title = [string]$f.title }) }
    foreach ($a2 in $discovery[$key].added) { [void]$out.sources[$key]['discover'].added.Add([int]$a2) }
  }
  $r = $results | Where-Object { $_.key -eq $key -and $_.id -eq $aid -and $_.part -eq $apart } | Select-Object -First 1
  $item = Load-Item $key $aid $apart
  if (-not $item) { $item = @{ csv = '' } }
  $item['id'] = $aid; $item['partIndex'] = $apart
  $item['status'] = if ($r) { [string]$r.status } else { 'missing' }
  $item['error'] = if ($r -and $r.error) { [string]$r.error } else { $null }
  [void]$out.sources[$key].items.Add($item)
}
$js = "window.PENSION_DATA = " + $ser.Serialize($out) + ";"
[IO.File]::WriteAllText((Join-Path $root 'data\data.js'), $js, $utf8)

$ok = @($results | Where-Object status -eq 'ok').Count
$cached = @($results | Where-Object status -eq 'cached').Count
$missing = @($results | Where-Object status -eq 'missing').Count
Write-Host ''
Write-Host "Done. ok=$ok  cached(kept previous copy)=$cached  missing=$missing"
if ($missing -gt 0) { exit 2 } elseif ($cached -gt 0) { exit 1 } else { exit 0 }
