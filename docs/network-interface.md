# FTP and SFTP network interface selection

Use a named network adapter for one FTP or SFTP configuration without changing
system-wide routing:

```json
{
  "protocol": "sftp",
  "networkInterface": "Ethernet"
}
```

This is a fragment, not a complete configuration. Run **SFTP: Select
Network Interface**, choose the connection/profile and adapter, then save.
**Use system routing** writes `null` and disables an inherited profile value.

## Behavior

- Supports FTP and SFTP, including configurations that omit `protocol` (SFTP).
- Uses the exact adapter name reported by the operating system and requires a usable IPv4
  address.
- Binds the SFTP SSH socket and all transfers over that connection. With SSH
  hopping, the base configuration describes the first hop: select the adapter
  there. Subsequent hops use forwarded channels over that same connection.
- Binds FTP control and passive data sockets, including plain FTP and
  experimental FTPS.
- A missing/unavailable adapter fails explicitly. There is no fallback to
  another adapter.
- If several IPv4 addresses exist, the first sorted address is used.
- VPN kill switches or packet interception can still block the connection.

This option does not modify system routes or VPN configuration. Use **Test
Connection** after selecting an adapter.
