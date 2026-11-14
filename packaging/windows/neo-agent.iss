; The Windows installer of Neo Agent (Inno Setup 6): the app, its backend and the bundled runtimes, installed for
; the current user without administrator rights.
;
; Build: iscc /DAppVersion=0.2.0 /DStage=<folder> packaging\windows\neo-agent.iss
; <folder> holds what packaging\windows\stage.ps1 put together: the Flutter app (neo_agent.exe, its DLLs and data),
; neo-agent.exe, shim\ and runtimes\.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\..\dist\windows-stage"
#endif

[Setup]
AppId={{6C0B6A0E-6C1D-4E57-9A53-3C0E3B1D7A51}
AppName=Neo Agent
AppVersion={#AppVersion}
AppPublisher=Neo Agent
DefaultDirName={localappdata}\Programs\Neo Agent
DefaultGroupName=Neo Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Neo-Agent-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\neo_agent.exe
; A running app is asked to close before its files are replaced.
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Neo Agent"; Filename: "{app}\neo_agent.exe"
Name: "{autodesktop}\Neo Agent"; Filename: "{app}\neo_agent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\neo_agent.exe"; Description: "{cm:LaunchProgram,Neo Agent}"; Flags: nowait postinstall skipifsilent
