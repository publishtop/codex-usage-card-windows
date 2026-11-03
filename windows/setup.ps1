param([ValidateSet('Install','Check','Status','Uninstall')][string]$Mode='Check')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$package=Split-Path -Parent $PSScriptRoot
try{
    $candidates=@()
    $command=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if($command){$candidates+=$command.Source}
    foreach($folder in @($env:ProgramFiles,${env:ProgramFiles(x86)},(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'))){if($folder){$candidates+=(Join-Path $folder 'nodejs\node.exe')}}
    $node=$null
    foreach($candidate in $candidates | Select-Object -Unique){if(Test-Path -LiteralPath $candidate){$version=& $candidate --version 2>$null;if($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24){$node=$candidate;break}}}
    if(-not $node){throw 'Node.js 24+ was not found. Install the x64 version from https://nodejs.org/ then retry.'}
    $manager=Join-Path $package 'manage.cjs'
    if($Mode -eq 'Status' -or $Mode -eq 'Uninstall'){
        & $node $manager ($Mode.ToLowerInvariant())
        if($LASTEXITCODE -ne 0){throw ($Mode+' did not complete; see the error above.')}
        exit 0
    }
    if(-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)){throw 'Windows ScheduledTasks support was not found.'}
    if((Get-Service -Name Schedule).Status -ne 'Running'){throw 'Windows Task Scheduler service is not running. Ask your administrator to enable it.'}
    Write-Host 'Checking package, Windows dependencies, Codex and signed-in quota access...'
    $report=& $node (Join-Path $package 'preflight.cjs')
    if($LASTEXITCODE -ne 0){throw 'Preflight failed. No installation changes were made. Resolve the message above and retry.'}
    $checked=$report | ConvertFrom-Json
    if(-not $checked.ok){throw 'Preflight did not confirm readiness.'}
    Write-Host 'Checks passed. Quota queries do not call the model.' -ForegroundColor Green
    if($Mode -eq 'Check'){exit 0}
    & $node $manager install
    if($LASTEXITCODE -ne 0){throw 'Installation failed. See the message above.'}
    $ready=$false
    for($attempt=0;$attempt -lt 10;$attempt++){
        Start-Sleep -Seconds 2
        $health=& $node $manager health
        if($LASTEXITCODE -eq 0){$status=$health|ConvertFrom-Json;if($status.ok){$ready=$true;break}}
    }
    if(-not $ready){throw 'Installed files, but the background agent did not report ready. Run Check.cmd and Status.cmd; installation is not yet verified.'}
    Write-Host 'Background agent is running. The current work window has been preserved.' -ForegroundColor Green
    $answer=Read-Host 'Save your work. Normally restart Codex now to load the card? [Y/N]'
    if($answer -match '^y(es)?$'){
        & $node $manager restart-now --confirm-work-saved
        if($LASTEXITCODE -ne 0){throw 'Normal restart did not complete. No forced termination was used. Run Status.cmd for details.'}
        Write-Host 'Normal restart requested. Codex will reopen automatically; allow startup to complete.'
    }else{
        Write-Host 'You can enable later by fully exiting Codex, or run: node manage.cjs restart-now --confirm-work-saved'
    }
    exit 0
}catch{
    Write-Host ('ERROR: '+$_.Exception.Message) -ForegroundColor Red
    exit 1
}
