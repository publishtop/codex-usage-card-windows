using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using System.Collections.Generic;

// A windowless, current-user host. No scripts, UI hooks, credentials or model calls.
internal static class AgentHost {
    static int Main(){
        string root=AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var json=new JavaScriptSerializer();
        try{
            var marker=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"installation.json")));
            if(Convert.ToString(marker["owner"])!="codex-usage-card-windows-v1"||!String.Equals(Path.GetFullPath(Convert.ToString(marker["root"])).TrimEnd(Path.DirectorySeparatorChar),root,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Installation ownership mismatch");
            var settings=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"settings.json")));
            string node=Convert.ToString(settings["nodePath"]),worker=Path.Combine(root,"windows-agent.cjs");
            if(!File.Exists(node)||!String.Equals(Path.GetFileName(node),"node.exe",StringComparison.OrdinalIgnoreCase)||!File.Exists(worker))throw new InvalidOperationException("Node.js or installed worker is missing");
            var start=new ProcessStartInfo(node,"\""+worker+"\""){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=root};
            start.EnvironmentVariables["CODEX_USAGE_CARD_HOME"]=root;
            using(var child=Process.Start(start)){child.WaitForExit();return child.ExitCode;}
        }catch(Exception error){
            try{File.WriteAllText(Path.Combine(root,"host-error.json"),json.Serialize(new{at=DateTime.UtcNow.ToString("o"),message=error.Message}));}catch{}
            return 1;
        }
    }
}
