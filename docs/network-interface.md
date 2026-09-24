# FTP network interface selection

Use a named Windows network adapter for one FTP configuration without changing
system-wide routing:

```json
{
  "protocol": "ftp",
  "networkInterface": "Ethernet"
}
```

This is a fragment, not a complete configuration. Run **SFTP: Select
Network Interface**, choose the connection/profile and adapter, then save.
**Use system routing** writes `null` and disables an inherited profile value.

## Behavior

- FTP only; SFTP rejects this setting.
- Uses the exact adapter name reported by Windows and requires a usable IPv4
  address.
- Binds FTP control and passive data sockets, including plain FTP and
  experimental FTPS.
- A missing/unavailable adapter fails explicitly. There is no fallback to
  another adapter.
- If several IPv4 addresses exist, the first sorted address is used.
- VPN kill switches or packet interception can still block the connection.

This option does not modify Windows routes or VPN configuration. Use **Test
Connection** after selecting an adapter.
