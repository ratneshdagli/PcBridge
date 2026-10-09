' Starts PC Bridge without any console window. Needs Node.js on PATH. A second start just opens the window of the running service.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments: args = args & " " & a: Next
sh.Run "cmd /c cd /d """ & dir & """ && node dist\src\server.js" & args, 0, False
