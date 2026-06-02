$lines = Get-Content "scratch/S-CLEAN1_old_before_2026-05-25.txt"
$archive = @()
$review = @()
$i=0
foreach ($line in $lines) {
  $i++
  if ($i % 25 -eq 0) { Write-Host "Processed $i / $($lines.Count)..." }
  if ($line -match '^(?<dt>.*) (?<ref>origin/[^ ]+) (?<subj>.*)$') {
    $ref = $matches.ref
    $subj = $matches.subj
    $isWipOrRecovery = $ref -match 'origin/(wip|recovery)/'
    $isMerged = $false
    & git -C "C:\Users\Cash4\repos\repid-engine" merge-base --is-ancestor $ref origin/main 2>$null | Out-Null
    $isMerged = ($LASTEXITCODE -eq 0)
    if ($isWipOrRecovery -or $isMerged) {
      $reason = if ($isWipOrRecovery) { "wip/recovery snapshot" } else { "merged to main (ancestor)" }
      $archive += "$ref | $reason | $subj"
    } else {
      $changed = & git -C "C:\Users\Cash4\repos\repid-engine" diff --name-only $ref origin/main 2>$null | Where-Object { $_ -and $_.Trim() }
      $changedCount = ($changed | Measure-Object).Count
      if ($changedCount -gt 0) {
        $sample = ($changed | Select-Object -First 3) -join ", "
        $review += "$ref | unique files ($changedCount): $sample | $subj"
      } else {
        $archive += "$ref | no unique diff vs main | $subj"
      }
    }
  }
}
Write-Host "ARCHIVE: $($archive.Count)"
Write-Host "REVIEW: $($review.Count)"
$archive | Out-File "scratch/S-CLEAN1_archive.txt" -Encoding utf8
$review | Out-File "scratch/S-CLEAN1_review.txt" -Encoding utf8
Write-Host "Saved."
