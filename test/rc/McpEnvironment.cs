using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Windows x64 QA only. The PowerShell caller first verifies this is an owned,
// already-started packaged MCP child. Return just the one ephemeral capability,
// never a dump of its environment. Not included in the product VSIX.
public static class RcMcpEnvironment {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo {
    public IntPtr Reserved1, Peb, Reserved2, Reserved3, Pid, Reserved4;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr process, int type, ref BasicInfo info, int length, out int returned);
  private static byte[] Read(IntPtr process, IntPtr address, int size) {
    var bytes = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(process, address, bytes, size, out read) || read.ToInt32() != size)
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return bytes;
  }
  private static IntPtr Pointer(IntPtr process, IntPtr address) {
    return new IntPtr(BitConverter.ToInt64(Read(process, address, 8), 0));
  }
  public static string Configuration(int pid) {
    if (IntPtr.Size != 8) throw new InvalidOperationException("QA supports Windows x64 only");
    var process = OpenProcess(0x0410, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var info = new BasicInfo(); int returned;
      if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0)
        throw new InvalidOperationException("Could not query owned MCP process");
      var parameters = Pointer(process, IntPtr.Add(info.Peb, 0x20));
      var environment = Pointer(process, IntPtr.Add(parameters, 0x80));
      var buffer = new byte[2 * 1024 * 1024];
      int previous = -1;
      for (int offset = 0; offset < buffer.Length; offset += 4096) {
        var chunk = Read(process, IntPtr.Add(environment, offset), 4096);
        Array.Copy(chunk, 0, buffer, offset, chunk.Length);
        for (int i = offset; i < offset + chunk.Length; i += 2) {
          int current = buffer[i] | (buffer[i + 1] << 8);
          if (previous == 0 && current == 0) {
            var text = Encoding.Unicode.GetString(buffer, 0, i);
            foreach (var entry in text.Split('\0')) {
              const string prefix = "SFTP_SYNC_AI_MCP_CONFIG=";
              if (entry.StartsWith(prefix, StringComparison.Ordinal)) return entry.Substring(prefix.Length);
            }
            throw new InvalidOperationException("Packaged MCP child has no capability");
          }
          previous = current;
        }
      }
      throw new InvalidOperationException("Owned MCP environment exceeds QA budget");
    } finally { CloseHandle(process); }
  }
}
