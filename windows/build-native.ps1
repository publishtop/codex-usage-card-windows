$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=[IO.Path]::GetFullPath($env:WSC_ROOT)
$marker=Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($marker.owner -ne 'codex-usage-card-windows-v1' -or [IO.Path]::GetFullPath($marker.root) -ne $root){throw 'Installation ownership mismatch'}
function Build-Helper([string]$SourceName,[string]$Prefix,[string]$Target){
    $source=Join-Path $root ('windows\'+$SourceName)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$digest=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-','').ToLower()}finally{$sha.Dispose()}
    $output=Join-Path $root ($Prefix+'-'+$digest.Substring(0,12)+'.exe')
    if(-not (Test-Path -LiteralPath $output)){
        $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $temporary=$output+'.tmp.exe'
        $messages=& $compiler /nologo ('/target:'+$Target) /platform:x64 /optimize+ /reference:System.Web.Extensions.dll ('/out:'+$temporary) $source
        if($LASTEXITCODE -ne 0){throw ('Native helper compilation failed: '+($messages -join ' '))}
        Move-Item -LiteralPath $temporary -Destination $output
    }
    return @{file=$output;digest=$digest}
}
$bridge=Build-Helper 'StartupBridge.cs' 'startup-bridge' 'exe'
$hostProgram=Build-Helper 'AgentHost.cs' 'agent-host' 'winexe'
[pscustomobject]@{nativeBridge=$bridge.file;nativeSourceSha256=$bridge.digest;agentHost=$hostProgram.file;agentHostSha256=$hostProgram.digest}|ConvertTo-Json -Compress
