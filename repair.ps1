$lines = Get-Content pull_debug.txt
foreach ($line in $lines) {
    if ($line.Trim().StartsWith("supabase migration repair")) {
        $cmd = $line.Trim()
        Write-Host "Running: npx $cmd"
        Invoke-Expression "npx $cmd"
    }
}
