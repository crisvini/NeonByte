# HTTP Recovery Implementation Plan

**Goal:** Recover a sequential HTTP server after interrupted clients, bound large
uploads, expose authenticated diagnostics and preserve the existing OTA safety
transaction and private identity.

**Architecture:** Retain one active socket. Track its ownership independently of
`WiFiClient::operator bool`, clean request state before accepting another socket,
and preserve the pending reboot after OTA activation. Keep inactivity and bounded
size-based total deadlines. Publish volatile, aggregate diagnostics only through
an authenticated maintenance extension. Keep display and LittleFS unchanged
unless offline evidence justifies a bounded change.

**Constraints:** No device access or operations; no OTA; no deployment-guard,
partition, authentication, recovery identity or display-orientation changes.
No simultaneous HTTP clients. The private target build uses the existing identity.

1. Reproduce disconnected header, upload, hash and response state in the actual
   target HTTP loop with socket doubles; verify post-disconnect HTTP recovery.
   Cover pending OTA activation and timeout cleanup before implementing fixes.
2. Correct socket ownership/cleanup and finite size-based upload deadlines.
   Update the agent's upload timeout with independent unit tests.
3. Add authenticated, non-secret diagnostics for memory, connection, transfer,
   reset and loop timing; test denied and valid requests and counter behavior.
4. Run native, offline agent, repository and adapter fault tests, including
   ASan/UBSan. Keep existing OTA fault, image and deployment-guard tests.
5. Build in a separate, network-isolated private profile using the existing
   recovery header; validate identity preservation, flags, size, SHA-256, E9,
   CRC and provisional geometry. Document results and unresolved hardware risks.
