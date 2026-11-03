param([ValidateSet('Install','Start','Uninstall')][string]$Mode = 'Install')
$ErrorActionPreference = 'Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [IO.Path]::GetFullPath($env:WSC_ROOT)
$marker = Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($marker.owner -ne 'codex-usage-card-windows-v1' -or [IO.Path]::GetFullPath($marker.root) -ne $root) { throw 'Installation ownership mismatch' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory may not be a reparse point' }
$settings = Get-Content -LiteralPath (Join-Path $root 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskPath = '\CodexUsageCard\'
$taskName = 'Agent'
$agentHost = [IO.Path]::GetFullPath($settings.agentHost)
if([IO.Path]::GetDirectoryName($agentHost) -ne $root -or [IO.Path]::GetFileName($agentHost) -notmatch '^agent-host-[a-f0-9]{12}\.exe$' -or -not (Test-Path -LiteralPath $agentHost)){throw 'Invalid installed agent host'}
$existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $actions = @($existing.Actions)
    if ($actions.Count -ne 1) { throw 'A task with this name belongs to another installation' }
    $legacy=$actions[0].Execute -eq (Join-Path $env:SystemRoot 'System32\wscript.exe') -and $actions[0].Arguments -eq ('//B //NoLogo "'+(Join-Path $root 'start-agent.vbs')+'"')
    $native=[IO.Path]::GetDirectoryName($actions[0].Execute) -eq $root -and [IO.Path]::GetFileName($actions[0].Execute) -match '^agent-host-[a-f0-9]{12}\.exe$' -and [string]::IsNullOrEmpty($actions[0].Arguments)
    if(-not $legacy -and -not $native){throw 'A task with this name belongs to another installation'}
}
function Stop-OwnedWorker {
    $workerFile = Join-Path $root 'windows-agent.cjs'
    foreach ($workerProcess in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
        if ($workerProcess.ExecutablePath -and $workerProcess.ExecutablePath.Equals($settings.nodePath,[StringComparison]::OrdinalIgnoreCase) -and $workerProcess.CommandLine -and $workerProcess.CommandLine.IndexOf($workerFile,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $workerProcess.ProcessId -ErrorAction SilentlyContinue
            Wait-Process -Id $workerProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
}
if ($Mode -eq 'Uninstall') {
    if ($existing) {
        Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false
    }
    Stop-OwnedWorker
    [pscustomobject]@{ ok=$true; taskRemoved=[bool]$existing } | ConvertTo-Json -Compress
    exit 0
}
if ($Mode -eq 'Start') {
    if (-not $existing) { throw 'The installed background task is missing' }
    if ($existing.State -ne 'Running') { Stop-OwnedWorker; Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName }
    [pscustomobject]@{ ok=$true; requested='start' } | ConvertTo-Json -Compress
    exit 0
}
if ($existing) {
    Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ((Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -ne 'Running') { break }
        Start-Sleep -Milliseconds 100
    }
}
Stop-OwnedWorker
$action = New-ScheduledTaskAction -Execute $agentHost -WorkingDirectory $root
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $logonTrigger -Settings $taskSettings -Principal $principal -Description 'Windows port of Lorie7813/codex-usage-card. Local sidebar usage rings; never forcibly closes Codex.' -Force | Out-Null
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
[pscustomobject]@{ ok=$true; task='\CodexUsageCard\Agent'; createsIcons=$false } | ConvertTo-Json -Compress
