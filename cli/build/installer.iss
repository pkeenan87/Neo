; installer.iss — Inno Setup script for Neo Security Agent CLI
; The version is passed in via /DAppVersion=x.y.z from build-installer.ps1

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppName=Neo Security Agent CLI
AppVersion={#AppVersion}
AppPublisher=Neo Security
DefaultDirName={autopf}\Neo
DefaultGroupName=Neo
OutputDir=..\dist
OutputBaseFilename=NeoSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
PrivilegesRequired=admin
UninstallDisplayName=Neo Security Agent CLI
SetupIconFile=compiler:SetupClassicIcon.ico

[Files]
Source: "..\dist\neo.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Neo CLI"; Filename: "{app}\neo.exe"
Name: "{group}\Uninstall Neo"; Filename: "{uninstallexe}"

[Registry]
; Add install directory to system PATH
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
    ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; \
    Check: NeedsAddPath('{app}')

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path', OrigPath)
  then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + UpperCase(Param) + ';', ';' + UpperCase(OrigPath) + ';') = 0;
end;
