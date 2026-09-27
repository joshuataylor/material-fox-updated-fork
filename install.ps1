param (
  # Release to install, as a GitHub releases API path: "latest" or "tags/vX.Y.Z".
  [string]$Version = $(if ($env:MATERIAL_FOX_VERSION) { $env:MATERIAL_FOX_VERSION } else { "latest" }),
  # Repository to install from. Defaults to this fork; set MATERIAL_FOX_REPO to override.
  [string]$Repo = $(if ($env:MATERIAL_FOX_REPO) { $env:MATERIAL_FOX_REPO } else { "joshuataylor/material-fox-updated-fork" })
)

# Releases up to v2.0.0 (e.g. v1.0.7 for Firefox 119 and below) were only published upstream, so a
# tag this fork has no release for falls back to the original repository.
$UpstreamRepo = "edelvarden/material-fox-updated"
$AppName = "material-fox-updated"

function Get-FirefoxProfileDirectory {

  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $false)]
    [string]$ProfileName = ""
  )

  $browserDirectories = @(
    "$env:APPDATA\Mozilla\Firefox",
    "$env:APPDATA\Waterfox",
    "$env:APPDATA\librewolf",
    "$env:APPDATA\Floorp"
  )

  # If there are multiple browsers, prompt the user to select one
  $selectedDirectories = @()

  foreach ($firefoxBrowserDirectory in $browserDirectories) {
    if (Test-Path -Path $firefoxBrowserDirectory) {
      $selectedDirectories += $firefoxBrowserDirectory
    }
  }

  if ($selectedDirectories.Count -eq 0) {
    return ""
  }

  if ($selectedDirectories.Count -gt 1) {
    $BrowserProfile = Show-ConsoleMenu -Items $selectedDirectories -Prompt "Select a Firefox browser profile directory"
  }
  else {
    $BrowserProfile = $selectedDirectories[0]
  }

  $profilesDirectory = "$BrowserProfile\Profiles"

  $profileDirectories = (Get-ChildItem -Path $profilesDirectory -Directory  |
    Where-Object {
      if (Get-ChildItem $_.FullName -File -Name "*prefs.js") {
        return $true
      }
      else {
        return $false
      }
    } |
    Sort-Object Name)

  if ($profileDirectories.Count -gt 1) {
    $ProfileName = Show-ConsoleMenu -Items $profileDirectories.Name -Prompt "Select a Firefox profile"
  }
  else {
    $ProfileName = $profileDirectories[0].Name
  }

  if ($ProfileName) {
    return "$profilesDirectory\$ProfileName"
  }
  else {
    Write-Warning "Couldn't retrieve the Firefox profile directory!"
    return
  }
}

function Show-ConsoleMenu {
  param (
    [Parameter(Mandatory = $true)]
    [string[]]$Items,
    [Parameter(Mandatory = $true)]
    [string]$Prompt
  )

  if ($Items.Count -eq 0) {
    Write-Host "No items to display."
    return
  }

  $selectedIndex = 0
  $itemCount = $Items.Count

  # Display the prompt and move cursor to the next line
  Write-Host "? " -ForegroundColor Yellow -NoNewline
  Write-Host "$Prompt " -ForegroundColor White -NoNewline
  Write-Host ""

  # Capture the line where the menu starts
  $menuStartLine = $Host.UI.RawUI.CursorPosition.Y

  # Function to redraw the menu
  function Redraw-Menu {
    $Host.UI.RawUI.CursorPosition = @{X = 0; Y = $menuStartLine }

    # Clear previous menu lines
    for ($i = 0; $i -lt $itemCount; $i++) {
      $Host.UI.RawUI.CursorPosition = @{X = 0; Y = $menuStartLine + $i }
      Write-Host (" " * $Host.UI.RawUI.WindowSize.Width) -NoNewline
    }

    # Redraw menu
    for ($i = 0; $i -lt $itemCount; $i++) {
      $Host.UI.RawUI.CursorPosition = @{X = 0; Y = $menuStartLine + $i }
      if ($i -eq $selectedIndex) {
        Write-Host (" > $($Items[$i])".PadRight($Host.UI.RawUI.WindowSize.Width)) -ForegroundColor Cyan
      }
      else {
        Write-Host ("   $($Items[$i])".PadRight($Host.UI.RawUI.WindowSize.Width)) -ForegroundColor DarkGray
      }
    }
  }

  Redraw-Menu

  while ($true) {
    try {
      $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown').VirtualKeyCode
    }
    catch {
      # Handle Ctrl+C or other interruptions
      Clear-Host
      Write-Host "Interrupted. Exiting..."
      return
    }

    switch ($key) {
      38 {
        # Up Arrow
        $selectedIndex = ($selectedIndex - 1) % $itemCount
        if ($selectedIndex -lt 0) { $selectedIndex = $itemCount - 1 }
      }
      40 {
        # Down Arrow
        $selectedIndex = ($selectedIndex + 1) % $itemCount
      }
      13 {
        # Enter
        return $Items[$selectedIndex]
      }
    }

    Redraw-Menu
  }
}



function Show-ConfirmationDialog {
  param (
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $selectedOption = $null

  while ($null -eq $selectedOption) {
    Write-Host "? "  -ForegroundColor Yellow -NoNewline
    Write-Host "$Message " -ForegroundColor White -NoNewline
    Write-Host "(y/n) > " -ForegroundColor DarkGray -NoNewline
        
    $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown').VirtualKeyCode

    switch ($key) {
      89 {
        # Y key
        $selectedOption = "yes"
        Write-Host "yes" -ForegroundColor Green
      }
      78 {
        # N key
        $selectedOption = "no"
        Write-Host "no" -ForegroundColor Red
      }
      13 {
        # Enter
        $selectedOption = "no"
        Write-Host "no" -ForegroundColor Red
      }
      default {
        break
      }
    }

    if (-not $selectedOption) {
      Write-Host "`b`b`b`b" -NoNewline  # Backspace characters to overwrite the " › " prompt
    }
  }

  return $selectedOption
}

function Update-FirefoxTheme {
    
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$DownloadUrl,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  try {
    $hash = [System.Guid]::NewGuid().ToString("N")
    $tempDir = $env:TEMP
    $zipPath = Join-Path $tempDir ("$AppName" + "_" + $hash + ".zip")

    # Create temp directory if it doesn't exist
    if (!(Test-Path $tempDir)) {
      New-Item -ItemType Directory -Path $tempDir | Out-Null
    }

    # Download the latest version of the portable app
    (New-Object System.Net.WebClient).DownloadFile($DownloadUrl, $zipPath)

    Expand-Archive -LiteralPath $zipPath -DestinationPath $DestinationPath -Force
  }
  catch {
    Write-Warning "Couldn't install the Firefox theme!"
  }
  finally {
    Write-Host "Done. Cleaning up temp files..."
    Remove-Item $zipPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}


function Get-FileDownloadUrlFromGithubReleases {
    
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasesUrl,
    [Parameter(Mandatory = $true)]
    [string]$FileName
  )

  try {
    # Get download url from github realeses
    $source = (Invoke-RestMethod -Uri $ReleasesUrl -Method Get -ErrorAction Stop)

    return ($source[0].assets | Where-Object name -Match $FileName)[0].browser_download_url
  }
  catch {}

  return ""
}


function Resolve-ReleaseSource {
  # Finds the chrome.zip for $Version in $Repo, and the user.js from the same tag so the example
  # prefs match the installed theme. Only a pinned tag falls back to upstream; "latest" never does,
  # so a failed lookup can't silently install the unmaintained upstream release.

  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  $candidates = @($Repo)
  if ($Version -like "tags/*" -and $Repo -ne $UpstreamRepo) {
    $candidates += $UpstreamRepo
  }

  foreach ($candidate in $candidates) {
    $downloadUrl = Get-FileDownloadUrlFromGithubReleases -ReleasesUrl "https://api.github.com/repos/$candidate/releases/$Version" -FileName "chrome.zip"

    if ($downloadUrl) {
      if ($candidate -ne $Repo) {
        Write-Warning "No $($Version -replace 'tags/') release in $Repo, installing it from $candidate instead."
      }

      # Asset URLs look like .../releases/download/<tag>/chrome.zip
      $ref = "main"
      if ($downloadUrl -match '/releases/download/([^/]+)/') {
        $ref = $Matches[1]
      }

      return @{
        DownloadUrl       = $downloadUrl
        UserJSDownloadUrl = "https://raw.githubusercontent.com/$candidate/$ref/user.js"
      }
    }
  }

  return $null
}


function Invoke-Installation {

  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $false)]
    [string]$ProfileDirectory = (Get-FirefoxProfileDirectory)
  )

  $source = Resolve-ReleaseSource -Repo $Repo -Version $Version

  if (!($source)) {
    Write-Warning "Couldn't retrieve the download URL. Installation aborted."

    return
  }

  $DownloadUrl = $source.DownloadUrl
  $UserJSDownloadUrl = $source.UserJSDownloadUrl

  if ((!($ProfileDirectory)) -or (!(Test-Path -Path $ProfileDirectory))) {
    Write-Warning "Couldn't find the Firefox profile directory. Installation aborted."

    return
  }

  $isUpdate = $false

  if (-not (Test-Path "$ProfileDirectory\chrome")) {
    $isUpdate = $true
  }
  else {
    Write-Warning "The chrome folder already exists!"
    $confirmation = Show-ConfirmationDialog -Message "Do you want to overwrite?"

    if ($confirmation -eq "yes") {
      $isUpdate = $true
    }
  }

  if ($isUpdate) {
    Update-FirefoxTheme -DownloadUrl $DownloadUrl -DestinationPath $ProfileDirectory
  }

  # Also install the user.js file
  $includeUserJS = $false

  if (-not (Test-Path "$ProfileDirectory\user.js")) {
    $includeUserJS = $true
  }
  else {
    Write-Warning "The user.js file already exists!"
    $confirmation = Show-ConfirmationDialog -Message "Do you want to overwrite?"

    
    if ($confirmation -eq "yes") {
      $includeUserJS = $true
    }
  }

  if ($includeUserJS) {
    try {
      (New-Object System.Net.WebClient).DownloadFile($UserJSDownloadUrl, "$ProfileDirectory\user.js")
      Write-Host "Done. `user.js` successfully downloaded."
    }
    catch {
      Write-Warning "Couldn't download the user.js file!"
    }
  }
}

Clear-Host
Write-Host "----------------------------------------------------------------"  -ForegroundColor DarkGray
Write-Host "MaterialFox UPDATED ($($Version -replace 'tags/'))" -ForegroundColor White
Write-Host "----------------------------------------------------------------" -ForegroundColor DarkGray

Invoke-Installation
pause
