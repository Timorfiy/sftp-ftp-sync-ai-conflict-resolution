# FTP network interface selection

Use a named network adapter for one FTP configuration without changing the operating system's routing table or other applications:

```json
{
  "protocol": "ftp",
  "networkInterface": "Ethernet"
}
```

This is a fragment to add to an existing connection, not a complete `sftp.json`.

Run **SFTP: Select Network Interface** in the Command Palette. Select the configuration/profile, then the adapter. **Use system routing** restores the normal behavior. The command preserves unrelated fields and formatting and asks you to save an already modified configuration before proceeding.

## Behavior

- The value is the exact adapter name reported by Node.js (such as `Ethernet`, `Wi-Fi`, or `en0`), not an IP address. The current usable IPv4 address is resolved for each new FTP connection.
- Omission or `null` uses system routing. A profile inherits the base configuration unless it overrides `networkInterface`; setting it to `null` explicitly disables an inherited selection.
- The selection applies to the control connection and all passive EPSV/PASV data sockets: uploads, downloads, directory listings, backups and conflict snapshots. Plain FTP, explicit FTPS and implicit FTPS are supported.
- No IPv4 address or a missing adapter causes an explicit error before connecting. Losing the selected address invalidates cached connections; a new connection resolves the current address. A passive transfer fails if the pinned address disappears. There is no automatic fallback to another adapter.
- If an adapter has multiple usable IPv4 addresses, the first address in sorted order is selected. IPv6-only adapters are not supported by this option.
- The log reports `FTP via Ethernet (192.168.x.x)`. FTP credentials are not included in this message.
- This option is FTP-only. A named interface on an SFTP configuration is rejected instead of silently ignored.

The implementation binds each socket's source address through Node.js `localAddress`. On the tested Windows/Sota TUN setup this sends FTP directly through Ethernet while other applications retain their VPN route. VPN clients with a kill switch or different packet interception rules may block direct connections: this option does not disable or reconfigure a VPN.

## Maintenance

`basic-ftp` 6.0.1 has no public local-address option for all data sockets. The integration is isolated to `ftpNetworkBinding.ts` and replaces only that client's `_newSocket` factory. Implicit TLS receives the same source address through TLS options. No global socket prototype is modified. The dependency is pinned; before updating it, run the real socket tests in `test/core/ftpNetworkBinding.spec.js`, including both passive modes and both TLS modes.
