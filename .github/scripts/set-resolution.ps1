# Best-effort: force the primary display resolution on a GitHub Actions Windows
# runner so full-screen screenshot grabs have a consistent size across runs.
# Tries the requested mode, falls back to 1920x1080, and never throws fatally
# (the workflow step is continue-on-error). Uses ChangeDisplaySettings via P/Invoke.
param(
    [int]$Width = 2560,
    [int]$Height = 1600
)

$code = @'
using System;
using System.Runtime.InteropServices;
public static class NativeDisplay {
  [DllImport("user32.dll")]
  public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion; public ushort dmDriverVersion; public ushort dmSize;
    public ushort dmDriverExtra; public uint dmFields;
    public int dmPositionX; public int dmPositionY; public uint dmDisplayOrientation; public uint dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels; public uint dmBitsPerPel; public uint dmPelsWidth; public uint dmPelsHeight;
    public uint dmDisplayFlags; public uint dmDisplayFrequency;
    public uint dmICMMethod; public uint dmICMIntent; public uint dmMediaType; public uint dmDitherType;
    public uint dmReserved1; public uint dmReserved2; public uint dmPanningWidth; public uint dmPanningHeight;
  }
}
'@
Add-Type -TypeDefinition $code

function Set-Res([int]$w, [int]$h) {
    $dm = New-Object NativeDisplay+DEVMODE
    $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'NativeDisplay+DEVMODE')
    $dm.dmPelsWidth = $w
    $dm.dmPelsHeight = $h
    $dm.dmBitsPerPel = 32
    # DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT
    $dm.dmFields = 0x40000 -bor 0x80000 -bor 0x100000
    return [NativeDisplay]::ChangeDisplaySettings([ref]$dm, 0)
}

$r = Set-Res $Width $Height
Write-Host "ChangeDisplaySettings(${Width}x${Height}) -> $r (0 = success)"
if ($r -ne 0) {
    $r = Set-Res 1920 1080
    Write-Host "fallback ChangeDisplaySettings(1920x1080) -> $r"
}
