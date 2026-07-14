# FTP(s) configuration

## ftpKeepAliveInterval
*number*: Interval in milliseconds between FTP `NOOP` commands. The keepalive prevents servers with short idle timeouts from closing the control connection.

Set to `0` to disable FTP keepalive.

**default**: 180000 (3 minutes)

## ftpReconnectAttempts
*number*: Number of times to reconnect automatically when the FTP control connection is closed. Operations that are safe to repeat, such as directory navigation and listing, are retried once the connection is restored. Streaming transfers and mutating file operations are not repeated automatically after a mid-command disconnect.

Set to `0` to disable automatic reconnect.

**default**: 1

## secure
*mixed*: Set to true for both control and data connection encryption.
Set to `control` for control encryption only, or `implicit` for implicitly encrypted control connection (this mode is deprecated in modern times, but usually uses port 990).

**default**: false

## secureOptions
Additional options to be passed to `tls.connect()`.
See [TLS connect options callback](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback).
