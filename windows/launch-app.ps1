param([switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUsageCardApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
public static class UsageCardApplicationLauncher
{
    [DllImport("ole32.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int CoCreateInstance(ref Guid classId, IntPtr outer, uint context, ref Guid interfaceId, out IntPtr result);

    public static uint Launch(string appId)
    {
        if (appId != "OpenAI.Codex_2p2nqsd0c76g0!App") throw new ArgumentException("Unexpected application identity");
        Guid classId = new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c");
        Guid interfaceId = new Guid("2e941141-7f97-4756-ba1d-9decde894a3d");
        IntPtr pointer;
        // A separate COM server preserves the lifetime of activation arguments.
        Marshal.ThrowExceptionForHR(CoCreateInstance(ref classId, IntPtr.Zero, 4, ref interfaceId, out pointer));
        object manager = null;
        try
        {
            manager = Marshal.GetObjectForIUnknown(pointer);
            uint pid;
            Marshal.ThrowExceptionForHR(((IUsageCardApplicationActivationManager)manager).ActivateApplication(appId,
                "--remote-debugging-address=127.0.0.1 --remote-debugging-port=39222", 0, out pid));
            return pid;
        }
        finally
        {
            if (manager != null) Marshal.FinalReleaseComObject(manager);
            Marshal.Release(pointer);
        }
    }
}
'@
if ($CompileOnly) { [pscustomobject]@{ok=$true; compiled=$true; launched=$false} | ConvertTo-Json -Compress; exit 0 }
$launchPid = [UsageCardApplicationLauncher]::Launch($env:WSC_APP_ID)
[pscustomobject]@{ ok=$true; pid=$launchPid; method='Windows Store activation'; forcedTermination=$false } | ConvertTo-Json -Compress
