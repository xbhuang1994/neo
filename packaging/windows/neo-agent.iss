; The Windows installer of Neo (Inno Setup 6): the app and its backend, installed for
; the current user without administrator rights.
;
; Build: iscc /DAppVersion=0.11.1 /DStage=<folder> packaging\windows\neo-agent.iss
; <folder> holds what packaging\windows\stage.ps1 put together: the Flutter app (neo_agent.exe, its DLLs and data)
; and neo-agent.exe. The Antigravity CLI is not bundled; the app installs it.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\..\dist\windows-stage"
#endif

[Setup]
AppId={{6C0B6A0E-6C1D-4E57-9A53-3C0E3B1D7A51}
AppName=Neo
AppVersion={#AppVersion}
AppPublisher=Neo
DefaultDirName={localappdata}\Programs\Neo
DefaultGroupName=Neo
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Neo-{#AppVersion}-windows-x64-setup
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
Name: "{group}\Neo"; Filename: "{app}\neo_agent.exe"
Name: "{autodesktop}\Neo"; Filename: "{app}\neo_agent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\neo_agent.exe"; Description: "{cm:LaunchProgram,Neo}"; Flags: nowait postinstall skipifsilent
