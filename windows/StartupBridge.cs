using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Native lifecycle metadata only. Never reads a chat, token, or process memory.
internal static class StartupBridge
{
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size, time; }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort length, maximum; public IntPtr buffer; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
    delegate bool WindowCallback(IntPtr window, IntPtr argument);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr argument);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint size);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int type, IntPtr buffer, uint length, out uint required);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly object InputGate = new object();
    static InputActivity Activity;
    static System.Threading.Timer InputTimer;
    static readonly double MonitorStartedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    static double LastInputPollAt=MonitorStartedAt;
    static uint LastForegroundPid;

    // Short-lived startup state only: no characters, key codes, text, or hooks are logged.
    internal sealed class InputActivity {
        internal readonly string key; internal readonly uint pid; internal readonly double launchedAt;
        internal readonly bool observedEarly;
        internal bool interacted,observationGap; internal int revision; internal double foregroundAt; bool[] previous;
        internal InputActivity(string key,uint pid,double launchedAt,bool early,bool[] held,bool foreground) {
            this.key=key;this.pid=pid;this.launchedAt=launchedAt;observedEarly=early;previous=held;
            // A held launch mouse button is harmless; a keyboard key already down in GPT is work.
            if(foreground)for(int i=7;i<held.Length;i++)if(held[i]){interacted=true;revision++;break;}
        }
        internal void Sample(bool[] down) {
            for(int i=0;i<down.Length;i++)if(down[i]&&!previous[i]){interacted=true;revision++;}
            previous=down;
        }
        internal void Foreground(double now,bool[] down){
            if(foregroundAt!=0)return;foregroundAt=now;
            for(int i=7;i<down.Length;i++)if(down[i]){interacted=true;revision++;break;}
            previous=down; // The initially held activation mouse button is not a new work click.
        }
        internal void ObservePollGap(double gap,bool foreground){
            // Before this application has ever been foreground, background startup
            // pauses are not evidence that input in an interactive window was missed.
            if(gap>500&&(foregroundAt!=0||foreground))observationGap=true;
        }
    }
    static bool[] Pressed(uint target) {
        var down=new bool[256];
        Point point;uint pointerOwner=0;if(GetCursorPos(out point))GetWindowThreadProcessId(WindowFromPoint(point),out pointerOwner);
        for(int i=1;i<256;i++) {
            // Modifier keys alone do not edit a work window; mouse motion has no virtual key.
            if(i==16||i==17||i==18||i==91||i==92||i>=160&&i<=165)continue;
            if(i<=6&&pointerOwner!=target)continue; // Taskbar and other-app mouse clicks are not GPT work.
            down[i]=(GetAsyncKeyState(i)&0x8000)!=0; // Only current high bit, never shared low-bit history.
        }
        return down;
    }
    static void PollInput(object unused) {
        lock(InputGate) {
            double now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),gap=now-LastInputPollAt;LastInputPollAt=now;
            uint foreground;GetWindowThreadProcessId(GetForegroundWindow(),out foreground);
            // Observe the first foreground transition on the native timer, even while
            // a process-enumeration request is delayed during Store cold activation.
            if(foreground!=LastForegroundPid){
                LastForegroundPid=foreground;
                if(foreground!=0&&(Activity==null||Activity.pid!=foreground)){
                    double launchedAt;string key;
                    if(TryFreshForeground(foreground,now,out launchedAt,out key)){
                        Activity=new InputActivity(key,foreground,launchedAt,gap<=500,Pressed(foreground),true);
                        Activity.foregroundAt=now;Activity.observationGap=gap>500;
                    }
                }
            }
            if(Activity==null)return;
            Activity.ObservePollGap(gap,foreground==Activity.pid);
            if(foreground!=Activity.pid)return;
            if(Activity.foregroundAt==0)Activity.Foreground(now,Pressed(Activity.pid));
            if(now-Activity.launchedAt>120000||now-Activity.foregroundAt>8000)return;
            Activity.Sample(Pressed(Activity.pid));
        }
    }
    static bool TryFreshForeground(uint pid,double now,out double launchedAt,out string key){
        launchedAt=0;key=null;
        IntPtr handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)return false;
        try{
            uint length=32768;var file=new StringBuilder((int)length);
            if(!QueryFullProcessImageName(handle,0,file,ref length)||!Allowed(file.ToString()))return false;
            long created,exited,kernel,user;if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))return false;
            launchedAt=created/10000d-11644473600000d;
            if(launchedAt<MonitorStartedAt||now-launchedAt>120000)return false;
            key=pid+":"+created;return true;
        }finally{CloseHandle(handle);}
    }
    static object[] ObserveInput(List<object> apps,uint foreground,double now) {
        lock(InputGate) {
            if(apps.Count!=1)return new object[]{false,false,"none",null,true};
            var app=(Dictionary<string,object>)apps[0];double age=now-Convert.ToDouble(app["launchedAt"]);
            if(age<0||age>120000||app["debugPort"]!=null)return new object[]{false,false,"ineligible",null,true};
            string key=(string)app["key"];uint pid=Convert.ToUInt32(app["pid"]);
            if(Activity==null||Activity.key!=key){
                bool early=Convert.ToDouble(app["launchedAt"])>=MonitorStartedAt&&now-LastInputPollAt<=500;
                Activity=new InputActivity(key,pid,Convert.ToDouble(app["launchedAt"]),early,Pressed(pid),foreground==pid);
            }
            if(foreground==pid&&Activity.foregroundAt==0)Activity.Foreground(now,Pressed(pid));
            return new object[]{Activity.observedEarly,Activity.interacted,Activity.key+":"+Activity.revision,
                Activity.foregroundAt==0?null:(object)Math.Max(0,now-Activity.foregroundAt),Activity.observationGap};
        }
    }

    static bool Eligible(Dictionary<string,object> snapshot, Dictionary<string,object> app, Dictionary<string,object> request) {
        double age=Convert.ToDouble(snapshot["at"])-Convert.ToDouble(app["launchedAt"]);
        bool beforeInteractive=app.ContainsKey("restartWindowReady")&&(bool)app["restartWindowReady"]&&snapshot["foregroundAgeMs"]==null;
        bool foregroundReady=Convert.ToUInt32(snapshot["frontmostPid"])==Convert.ToUInt32(app["pid"])&&(bool)app["finishedLaunching"]&&snapshot["foregroundAgeMs"]!=null&&Convert.ToDouble(snapshot["foregroundAgeMs"])<=8000;
        return (bool)app["argumentsKnown"] && app["debugPort"]==null && age>=0 && age<=120000 && (bool)snapshot["inputObserved"] && !(bool)snapshot["interactedWithApp"] && !(bool)snapshot["inputObservationGap"] &&
            Convert.ToString(snapshot["inputStamp"])==Convert.ToString(request["inputStamp"]) && (beforeInteractive||foregroundReady);
    }
    static bool RestartWindow(IntPtr window){
        if(GetWindowTextLength(window)<=0)return false;
#if TEST_BRIDGE
        return true;
#else
        var name=new StringBuilder(256);GetClassName(window,name,256);return name.ToString()=="Chrome_WidgetWin_1";
#endif
    }

    static bool Allowed(string file) {
#if TEST_BRIDGE
        return String.Equals(file, Path.Combine(Root,"UsageCardFixture.exe"), StringComparison.OrdinalIgnoreCase);
#else
        return Regex.IsMatch(file, @"^[A-Z]:\\Program Files\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$", RegexOptions.IgnoreCase)
            || String.Equals(Path.GetDirectoryName(file),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","OpenAI","Codex"),StringComparison.OrdinalIgnoreCase)
                && Regex.IsMatch(file,@"\\(?:ChatGPT|Codex)\.exe$",RegexOptions.IgnoreCase);
#endif
    }
    static string CommandLine(IntPtr handle) {
        uint needed; NtQueryInformationProcess(handle,60,IntPtr.Zero,0,out needed);
        if(needed<16 || needed>131072) return null;
        IntPtr buffer=Marshal.AllocHGlobal((int)needed);
        try {
            if(NtQueryInformationProcess(handle,60,buffer,needed,out needed)!=0) return null;
            var value=(UnicodeString)Marshal.PtrToStructure(buffer,typeof(UnicodeString));
            return value.buffer==IntPtr.Zero ? null : Marshal.PtrToStringUni(value.buffer,value.length/2);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static Dictionary<string,object> Snapshot() {
        double startedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var apps=new List<object>(); uint foreground; GetWindowThreadProcessId(GetForegroundWindow(),out foreground);
        var input=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};
        if(!GetLastInputInfo(ref input)) throw new InvalidOperationException("Input state unavailable");
        int ownSession=Process.GetCurrentProcess().SessionId;
        foreach(var process in Process.GetProcesses()) {
            using(process) {
                string name;
                try { name=process.ProcessName; if(process.SessionId!=ownSession) continue; } catch { continue; }
#if TEST_BRIDGE
                if(name!="UsageCardFixture") continue;
#else
                if(!String.Equals(name,"ChatGPT",StringComparison.OrdinalIgnoreCase) && !String.Equals(name,"Codex",StringComparison.OrdinalIgnoreCase)) continue;
#endif
                IntPtr handle=OpenProcess(0x1000,false,(uint)process.Id); if(handle==IntPtr.Zero) continue;
                try {
                    uint size=32768; var path=new StringBuilder((int)size);
                    if(!QueryFullProcessImageName(handle,0,path,ref size) || !Allowed(path.ToString())) continue;
                    if(String.Equals(Path.GetFileName(path.ToString()),"Codex.exe",StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(Path.GetDirectoryName(path.ToString()),"ChatGPT.exe"))) continue;
                    long created,exit,kernel,user; if(!GetProcessTimes(handle,out created,out exit,out kernel,out user)) continue;
                    string arguments=CommandLine(handle);
                    // Unknown command lines are retained as ineligible, never treated as main candidates.
                    if(arguments!=null && Regex.IsMatch(arguments,@"(?:^|\s)--type=")) continue;
                    var match=arguments==null ? Match.Empty : Regex.Match(arguments,@"--remote-debugging-port(?:=|\s+)(\d+)");
                    bool visible=false,restartReady=false; int id=process.Id;
                    EnumWindows(delegate(IntPtr window,IntPtr unused){uint owner;GetWindowThreadProcessId(window,out owner);if(owner==id&&GetWindowTextLength(window)>0){if(IsWindowVisible(window))visible=true;if(RestartWindow(window))restartReady=true;}return true;},IntPtr.Zero);
                    apps.Add(new Dictionary<string,object>{{"pid",id},{"key",id+":"+created},{"createdFileTime",created.ToString()},
                        {"executable",path.ToString()},{"launchedAt",created/10000d-11644473600000d},{"argumentsKnown",arguments!=null},
                        {"debugPort",match.Success?(object)Int32.Parse(match.Groups[1].Value):null},{"finishedLaunching",visible},{"restartWindowReady",restartReady}});
                } finally { CloseHandle(handle); }
            }
        }
        double now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();var observation=ObserveInput(apps,foreground,now);
        return new Dictionary<string,object>{{"apps",apps},{"frontmostPid",foreground},{"inputStamp",observation[2]},
            {"inputObserved",observation[0]},{"interactedWithApp",observation[1]},
            {"foregroundAgeMs",observation[3]},{"inputObservationGap",observation[4]},{"snapshotDurationMs",now-startedAt},
            {"globalInputIdleMs",unchecked(GetTickCount()-input.time)},{"at",now}};
    }
    static bool ManualApproval(Dictionary<string,object> request,Dictionary<string,object> app){
        try{
            var approval=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Root,"manual-restart-request.json")));
            double now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return (string)approval["owner"]=="codex-usage-card-windows-v1"&&(bool)approval["confirmed"]&&
                Convert.ToString(approval["requestId"])==Convert.ToString(request["requestId"])&&
                Convert.ToInt32(approval["pid"])==Convert.ToInt32(app["pid"])&&Convert.ToString(approval["key"])==Convert.ToString(app["key"])&&
                Convert.ToDouble(approval["createdAt"])<=now+1000&&now-Convert.ToDouble(approval["createdAt"])<=120000&&Convert.ToDouble(approval["expiresAt"])>=now;
        }catch{return false;}
    }
    static object Quit(Dictionary<string,object> request, bool fixture, bool userRequested=false) {
        var snapshot=Snapshot(); var apps=(List<object>)snapshot["apps"];
        if(apps.Count!=1) return new {accepted=false,reason="not-single-instance"};
        var app=(Dictionary<string,object>)apps[0];
        if(Convert.ToString(request["key"])!=(string)app["key"] || Convert.ToInt32(request["pid"])!=Convert.ToInt32(app["pid"]))
            return new {accepted=false,reason="process-identity-changed"};
        if(!fixture) {
            var marker=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Root,"installation.json")));
            if((string)marker["owner"]!="codex-usage-card-windows-v1" || !String.Equals(Path.GetFullPath((string)marker["root"]).TrimEnd('\\'),Root.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Installation ownership mismatch");
            if(userRequested&&!ManualApproval(request,app))return new{accepted=false,reason="explicit-restart-approval-required",forced=false};
            if(!userRequested&&!Eligible(snapshot,app,request))
                return new {accepted=false,reason="launch-no-longer-idle"};
        }
        var windows=new List<IntPtr>();uint target=Convert.ToUInt32(app["pid"]);
        EnumWindows(delegate(IntPtr window,IntPtr unused){uint owner;GetWindowThreadProcessId(window,out owner);if(owner==target&&GetWindowTextLength(window)>0&&(IsWindowVisible(window)||RestartWindow(window)))windows.Add(window);return true;},IntPtr.Zero);
        if(windows.Count==0)return new {accepted=false,reason="no-interactive-window",forced=false};
        var queried=new List<IntPtr>();
        Action cancel=delegate(){foreach(var window in queried){UIntPtr ignored;SendMessageTimeout(window,0x16,UIntPtr.Zero,new IntPtr(1),3,500,out ignored);}};
        foreach(var window in windows){
            UIntPtr response;IntPtr sent=SendMessageTimeout(window,0x11,UIntPtr.Zero,new IntPtr(1),3,1000,out response);queried.Add(window);
            if(sent==IntPtr.Zero||response==UIntPtr.Zero){cancel();return new {accepted=false,reason="application-refused-or-unresponsive",forced=false};}
        }
        // Recheck identity and input immediately before committing an accepted polite exit.
        var current=Snapshot();var currentApps=(List<object>)current["apps"];
        if(currentApps.Count!=1 || (string)((Dictionary<string,object>)currentApps[0])["key"]!=(string)app["key"] || !fixture&&!userRequested&&!Eligible(current,(Dictionary<string,object>)currentApps[0],request) || userRequested&&!ManualApproval(request,app)){
            cancel();return new {accepted=false,reason="input-or-process-changed",forced=false};
        }
        if(userRequested){try{File.Delete(Path.Combine(Root,"manual-restart-request.json"));}catch{cancel();return new{accepted=false,reason="could-not-consume-restart-approval",forced=false};}}
        // ENDSESSION_CLOSEAPP only. No CRITICAL flag, WM_CLOSE fallback, or process termination.
        foreach(var window in queried){UIntPtr ignored;SendMessageTimeout(window,0x16,new UIntPtr(1),new IntPtr(1),3,1000,out ignored);}
        return new {accepted=true,reason="polite-exit-requested",forced=false};
    }
    static object Execute(Dictionary<string,object> request) {
        string action=Convert.ToString(request["action"]);
        if(action=="snapshot")return Snapshot();
        if(action=="quit")return Quit(request,false);
        if(action=="user-requested-quit")return Quit(request,false,true);
#if TEST_BRIDGE
        if(action=="fixture-quit")return Quit(request,true);
        if(action=="fixture-pause-prewindow-observer"){
            var state=Snapshot();var apps=(List<object>)state["apps"];
            if(apps.Count!=1||(bool)((Dictionary<string,object>)apps[0])["finishedLaunching"])throw new InvalidOperationException("Requires one isolated pre-window fixture");
            lock(InputGate){System.Threading.Thread.Sleep(1126);}
            return new{paused=true};
        }
        if(action=="fixture-input-tests") {
            var held=new bool[256];held[1]=true;var tracker=new InputActivity("test",1,0,true,held,true);
            tracker.Sample(held);bool launchClickIgnored=!tracker.interacted;
            tracker.Sample(new bool[256]);bool mouseReleaseIgnored=!tracker.interacted;
            tracker.Sample(new bool[256]);bool pointerMotionIgnored=!tracker.interacted;
            var press=new bool[256];press[65]=true;tracker.Sample(press);bool typingDetected=tracker.interacted;
            var clickTracker=new InputActivity("click",1,0,true,new bool[256],true);clickTracker.Sample(held);
            var activation=new InputActivity("activation",1,0,true,new bool[256],false);activation.Foreground(1,held);activation.Sample(held);
            bool firstActivationClickIgnored=!activation.interacted;activation.Sample(new bool[256]);activation.Sample(held);
            return new{launchClickIgnored,mouseReleaseIgnored,pointerMotionIgnored,typingDetected,clickDetected=clickTracker.interacted,firstActivationClickIgnored,subsequentClickDetected=activation.interacted};
        }
        if(action=="fixture-observation-tests"){
            var app=new Dictionary<string,object>{{"pid",42},{"key","fixture"},{"launchedAt",1000d},{"argumentsKnown",true},{"debugPort",null},{"finishedLaunching",true}};
            var state=new Dictionary<string,object>{{"at",27709d},{"inputObserved",true},{"interactedWithApp",false},{"inputObservationGap",false},{"foregroundAgeMs",200d},{"inputStamp","fixture:0"},{"frontmostPid",42}};
            var guard=new Dictionary<string,object>{{"inputStamp","fixture:0"}};
            bool slowLaunchAllowed=Eligible(state,app,guard);
            state["foregroundAgeMs"]=8001d;bool existingWindowRejected=!Eligible(state,app,guard);state["foregroundAgeMs"]=200d;
            state["inputObservationGap"]=true;bool observationGapRejected=!Eligible(state,app,guard);state["inputObservationGap"]=false;
            state["interactedWithApp"]=true;bool typedWindowRejected=!Eligible(state,app,guard);
            return new{slowLaunchAllowed,existingWindowRejected,observationGapRejected,typedWindowRejected};
        }
        if(action=="fixture-prewindow-gap-tests"){
            var tracker=new InputActivity("prewindow",42,0,true,new bool[256],false);
            tracker.ObservePollGap(1126,false);bool prewindowGapIgnored=!tracker.observationGap;
            tracker.Foreground(2000,new bool[256]);tracker.ObservePollGap(20,true);
            bool freshForegroundAllowed=!tracker.observationGap&&!tracker.interacted;
            tracker.ObservePollGap(501,true);bool foregroundGapProtected=tracker.observationGap;
            var previous=new InputActivity("previous",42,0,true,new bool[256],false);
            previous.Foreground(1000,new bool[256]);previous.ObservePollGap(600,false);
            return new{prewindowGapIgnored,freshForegroundAllowed,foregroundGapProtected,previousForegroundProtected=previous.observationGap};
        }
#endif
        throw new ArgumentException("Unknown lifecycle action");
    }
    static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false); Console.InputEncoding=new UTF8Encoding(false);
        if(args.Length==1 && args[0]=="snapshot"){Console.WriteLine(Json.Serialize(Snapshot()));return 0;}
        InputTimer=new System.Threading.Timer(PollInput,null,10,10);
        string line;
        while((line=Console.ReadLine())!=null) {
            object id=null;
            try {var request=Json.Deserialize<Dictionary<string,object>>(line);id=request["id"];Console.WriteLine(Json.Serialize(new {id=id,result=Execute(request)}));}
            catch(Exception error){Console.WriteLine(Json.Serialize(new{id=id,error=error.Message}));}
        }
        InputTimer.Dispose();return 0;
    }
}
