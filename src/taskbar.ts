// The window is a browser "--app" window, so Windows groups it under the browser and "Pin to taskbar" would pin plain Edge/Chrome.
// This gives that one window its own taskbar identity (name, icon, relaunch command). One short PowerShell run per opened window.
import * as path from 'path';
import { spawn } from 'child_process';

const SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class Pin {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct Key { public Guid id; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] public struct Var { public ushort vt, r1, r2, r3; public IntPtr p; public IntPtr p2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IStore { void GetCount(out uint c); void GetAt(uint i, out Key k); void GetValue(ref Key k, out Var v); void SetValue(ref Key k, ref Var v); void Commit(); }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IStore s);
  delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static void Set(IStore s, uint pid, string v) {
    var k = new Key { id = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = pid };
    var x = new Var { vt = 31, p = Marshal.StringToCoTaskMemUni(v) };
    s.SetValue(ref k, ref x); Marshal.FreeCoTaskMem(x.p);
  }
  public static int Apply(string command, string icon) {
    int n = 0;
    EnumWindows((h, l) => {
      var t = new StringBuilder(64); GetWindowText(h, t, 64); var title = t.ToString();
      if (!IsWindowVisible(h) || (title != "PC Bridge" && title != "(down) PC Bridge")) return true;
      var iid = typeof(IStore).GUID; IStore s;
      if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0) return true;
      Set(s, 2, command); Set(s, 4, "PC Bridge"); Set(s, 3, icon); Set(s, 5, "PCBridge.App"); n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
for($i=0; $i -lt 40; $i++){ if([Pin]::Apply($env:PCB_RELAUNCH, $env:PCB_ICON) -gt 0){ exit 0 }; Start-Sleep -Milliseconds 500 }
exit 1
`;

/** Resolves when the window got its identity (or after about 25 s without one). Never throws. */
export function ownTaskbarIcon(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const root = path.join(__dirname, '..', '..');
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, PCB_RELAUNCH: `wscript.exe "${path.join(root, 'PC-Bridge.vbs')}"`, PCB_ICON: `${path.join(root, 'renderer', 'icon.ico')},0` } });
    p.on('exit', (code) => resolve(code === 0)); p.on('error', () => resolve(false));
  });
}
