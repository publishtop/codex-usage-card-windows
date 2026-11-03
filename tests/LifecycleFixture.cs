using System;
using System.Windows.Forms;
internal sealed class LifecycleFixture:Form {
    private readonly bool refuse;
    private LifecycleFixture(bool refuse){this.refuse=refuse;Text="Isolated usage-card lifecycle fixture";ShowInTaskbar=false;Opacity=0;Width=100;Height=80;}
    protected override void WndProc(ref Message m){
        if(m.Msg==0x11){m.Result=refuse?IntPtr.Zero:new IntPtr(1);return;}
        if(m.Msg==0x16&&m.WParam!=IntPtr.Zero){BeginInvoke(new Action(()=>Application.Exit()));return;}
        base.WndProc(ref m);
    }
    [STAThread] static void Main(string[] args){if(args.Length>0&&args[0]=="slow")System.Threading.Thread.Sleep(9000);var form=new LifecycleFixture(args.Length>0&&args[0]=="refuse");if(args.Length>0&&args[0]=="hidden"){var handle=form.Handle;Application.Run();}else Application.Run(form);}
}
