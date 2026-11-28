function Install-NeoAgent {
    [CmdletBinding()]
    param(
        [string]$Enroll,
        [string]$RelayUrl = "{{PUBLIC_URL}}",
        [string]$Version = "",
        [string]$Mode = "auto",
        [switch]$Upgrade,
        [switch]$Uninstall,
        [string]$Cluster = "",
        [switch]$PurgeWorkspace,
        [switch]$GithubOnly
    )

    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        # PowerShell 7+ manages TLS automatically.
    }

    $GitHubRepo = "xbhuang1994/neo"
    $RelayBase = $RelayUrl.TrimEnd("/")
    $BinDir = Join-Path $env:LOCALAPPDATA "neo-agent\bin"
    $BinPath = Join-Path $BinDir "neo-agent-os.exe"

    if ($Uninstall) {
        $FoundBin = $null
        if (Test-Path -LiteralPath $BinPath) {
            $FoundBin = $BinPath
        } else {
            $Cmd = Get-Command "neo-agent-os.exe" -ErrorAction SilentlyContinue
            if ($Cmd) {
                $FoundBin = $Cmd.Source
            }
        }
        if (-not $FoundBin) {
            throw "neo-agent-os.exe not found"
        }
        $UninstallArgs = @("uninstall")
        if (-not [string]::IsNullOrWhiteSpace($Cluster)) {
            $UninstallArgs += @("--cluster", $Cluster)
        }
        if ($PurgeWorkspace) {
            $UninstallArgs += "--purge-workspace"
        }
        & $FoundBin @UninstallArgs
        if ($LASTEXITCODE -ne 0) {
            throw "neo-agent-os uninstall failed with exit code $LASTEXITCODE"
        }
        return
    }

    if ($Mode -notin @("auto", "system", "user", "foreground")) {
        throw "Invalid -Mode '$Mode' (expected auto|system|user|foreground)"
    }
    if (-not $Upgrade -and [string]::IsNullOrWhiteSpace($Enroll)) {
        throw "Missing -Enroll parameter (or pass -Upgrade)"
    }

    if ([string]::IsNullOrWhiteSpace($Version)) {
        if (-not $GithubOnly -and -not [string]::IsNullOrWhiteSpace($RelayBase)) {
            try {
                $Latest = Invoke-RestMethod -Uri "$RelayBase/dl/latest.json" -TimeoutSec 15
                if ($Latest -and $Latest.version) {
                    $Version = [string]$Latest.version
                }
            } catch {
                Write-Warning "Failed to fetch latest version from relay mirror; falling back to GitHub API."
            }
        }
        if ([string]::IsNullOrWhiteSpace($Version)) {
            $GhRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest" -Headers @{ "User-Agent" = "neo-installer" } -TimeoutSec 20
            if ($GhRelease -and $GhRelease.tag_name) {
                $Version = [string]$GhRelease.tag_name
            }
        }
    }

    $Version = $Version.Trim().TrimStart("v")
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw "Failed to determine neo-agent-os version (pass -Version <ver>)"
    }

    $Tag = "v$Version"
    $Asset = "neo-agent-os-$Version-windows-x64.zip"
    $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("neo-install-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

    try {
        $DownloadFile = {
            param([string]$FileName, [string]$DestPath)
            if (-not $GithubOnly -and -not [string]::IsNullOrWhiteSpace($RelayBase)) {
                try {
                    Invoke-WebRequest -Uri "$RelayBase/dl/$Tag/$FileName" -OutFile $DestPath -UseBasicParsing -TimeoutSec 180
                    return
                } catch {
                    Write-Warning "Relay mirror unavailable for $FileName; falling back to GitHub..."
                }
            }
            Invoke-WebRequest -Uri "https://github.com/$GitHubRepo/releases/download/$Tag/$FileName" -OutFile $DestPath -UseBasicParsing -TimeoutSec 300
        }

        $ZipPath = Join-Path $TmpDir $Asset
        $SumsPath = Join-Path $TmpDir "SHA256SUMS.txt"

        Write-Host "Downloading $Asset ($Tag)..."
        & $DownloadFile $Asset $ZipPath
        & $DownloadFile "SHA256SUMS.txt" $SumsPath

        $ExpectedHash = $null
        foreach ($Line in (Get-Content -LiteralPath $SumsPath)) {
            $Trimmed = $Line.Trim()
            if ([string]::IsNullOrWhiteSpace($Trimmed)) { continue }
            $Parts = $Trimmed -split "\s+", 2
            if ($Parts.Count -eq 2) {
                $Name = $Parts[1].Trim()
                if ($Name.StartsWith("./")) { $Name = $Name.Substring(2) }
                if ($Name.StartsWith("*")) { $Name = $Name.Substring(1) }
                if ($Name -eq $Asset) {
                    $ExpectedHash = $Parts[0].Trim().ToLowerInvariant()
                    break
                }
            }
        }
        if (-not $ExpectedHash) {
            throw "Checksum entry for $Asset missing from SHA256SUMS.txt"
        }

        $ActualHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($ActualHash -ne $ExpectedHash) {
            throw "SHA-256 verification failed for $Asset (expected $ExpectedHash, got $ActualHash)"
        }

        $ExtractDir = Join-Path $TmpDir "extract"
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
        $ExtractedBin = Get-ChildItem -Path $ExtractDir -Filter "neo-agent-os.exe" -Recurse -File | Select-Object -First 1
        if (-not $ExtractedBin) {
            throw "neo-agent-os.exe not found inside $Asset"
        }
        $ExtractedBgBin = Get-ChildItem -Path $ExtractDir -Filter "neo-agent-os-bg.exe" -Recurse -File | Select-Object -First 1

        $InstallBinary = {
            param([string]$Src, [string]$Dst)
            if (Test-Path -LiteralPath $Dst) {
                $Old = "$Dst.old"
                Remove-Item -LiteralPath $Old -Force -ErrorAction SilentlyContinue
                try {
                    Move-Item -LiteralPath $Dst -Destination $Old -Force -ErrorAction Stop
                } catch {
                    # Fallback to direct overwrite below.
                }
            }
            Copy-Item -LiteralPath $Src -Destination $Dst -Force
        }

        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        & $InstallBinary $ExtractedBin.FullName $BinPath
        if ($ExtractedBgBin) {
            & $InstallBinary $ExtractedBgBin.FullName (Join-Path $BinDir "neo-agent-os-bg.exe")
        }

        if ($Upgrade) {
            Write-Host "Upgraded neo-agent-os.exe to v$Version at $BinPath"
            if (-not [string]::IsNullOrWhiteSpace($Cluster)) {
                try { & $BinPath repair-service --cluster $Cluster 2>$null | Out-Null } catch {}
                $TaskName = "NeoAgent-$Cluster"
                try { & schtasks /End /TN $TaskName 2>$null | Out-Null } catch {}
                try { & schtasks /Run /TN $TaskName 2>$null | Out-Null } catch {}
            } else {
                try { & $BinPath repair-service 2>$null | Out-Null } catch {}
            }
            return
        }

        $Enroll | & $BinPath enroll --relay-url $RelayBase --mode $Mode --ticket-stdin
        if ($LASTEXITCODE -ne 0) {
            throw "neo-agent-os enroll failed with exit code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
