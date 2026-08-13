# Third-party components

The optional Windows runtime downloaded by this plugin contains:

- `qsign-seru-fu` / `unidbg-fetch-qsign`, GPL-3.0: https://github.com/xueqi5201314/qsign-seru-fu
- `LagrangeGo`, AGPL-3.0: https://github.com/LagrangeDev/LagrangeGo
- `gofastTEA`, GPL-3.0: https://github.com/fumiama/gofastTEA
- A minimized GraalVM/OpenJDK Java 21 runtime. Its license files are retained in the runtime image.

The runtime bundle intentionally excludes QQ account tickets, device identity,
phone exports, `mobile-session.json`, local configuration, and logs. Those files
are generated locally after the owner imports their own Android QQ identity.
