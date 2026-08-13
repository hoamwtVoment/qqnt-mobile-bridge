# Runtime build

The published Windows runtime is built from public source and never from the
LiteLoader data directory.

1. Build `backend/` with Go 1.26 for `windows/amd64`.
2. Obtain `qsign-seru-fu` from the commit recorded in `NOTICE.md`; include its
   `bin/` and `lib/` directories.
3. Use JDK 21 `jdeps` and `jlink` to create a minimized runtime containing:
   `java.base,java.desktop,java.instrument,java.management,java.naming,java.sql,jdk.unsupported,org.graalvm.nativeimage`.
4. Include the qsign `dtconfig.json` template and the backend executable.
5. Confirm that the archive contains no `mobile-session.json`, `config.json`,
   `qsign-base`, identity archive, account number, UID, GUID, QIMEI, log, or
   absolute user path.
6. Publish the archive and update `RUNTIME_SHA256` in `main.js`.

The phone-specific qsign native libraries and the session file are created
locally after identity import. They are deliberately not Release assets.
