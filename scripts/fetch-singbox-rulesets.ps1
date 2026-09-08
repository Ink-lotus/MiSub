param([Parameter(Mandatory = $true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$sourceInfo = (& node (Join-Path $PSScriptRoot 'build-singbox-rulesets.mjs') --list-sources) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read catalog sources' }
$files = [System.Collections.Generic.List[object]]::new()

# GitHub API base64 preserves original bytes; cleaned raw pages lose line boundaries.
for ($offset = 0; $offset -lt $sourceInfo.sources.Count; $offset += 10) {
    $end = [Math]::Min($offset + 9, $sourceInfo.sources.Count - 1)
    $batch = @($sourceInfo.sources[$offset..$end])
    $urls = @($batch | ForEach-Object {
        "https://api.github.com/repos/ACL4SSR/ACL4SSR/contents/$($_.sourcePath)?ref=$($sourceInfo.revision)"
    })
    $response = (& tinyfish fetch content get @urls --format json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $response.errors.Count -gt 0 -or $response.results.Count -ne $batch.Count) {
        throw "Incomplete upstream batch starting at $offset"
    }
    foreach ($result in $response.results) {
        $body = if ($result.text -is [string]) { $result.text } else {
            ($result.text.children | Where-Object type -eq 'code' | ForEach-Object text) -join "`n"
        }
        $file = $body | ConvertFrom-Json
        if ($file.type -eq 'file' -and $file.encoding -eq 'none' -and $file.git_url) {
            $blobResponse = (& tinyfish fetch content get $file.git_url --format json) | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or $blobResponse.errors.Count -gt 0) { throw "Cannot fetch blob for $($file.path)" }
            $blob = (($blobResponse.results[0].text.children | Where-Object type -eq 'code' | ForEach-Object text) -join "`n") | ConvertFrom-Json
            if ($blob.sha -ne $file.sha -or $blob.size -ne $file.size) { throw "Mismatched blob for $($file.path)" }
            $file.encoding = $blob.encoding
            $file.content = $blob.content
        }
        if ($file.encoding -ne 'base64' -or $file.type -ne 'file' -or !$file.content) {
            throw "No lossless content for $($result.url)"
        }
        $files.Add([ordered]@{
            path = $file.path; sha = $file.sha; size = $file.size
            encoding = $file.encoding; content = $file.content
        })
    }
    Write-Host "Fetched $($files.Count)/$($sourceInfo.sources.Count) sources"
}
$snapshot = [ordered]@{ revision = $sourceInfo.revision; files = $files.ToArray() }
$absoluteOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.File]::WriteAllText($absoluteOutput, ($snapshot | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
Write-Host "Snapshot: $absoluteOutput"
