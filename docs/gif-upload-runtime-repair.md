# GIF Upload Runtime Repair

## Scope and Confirmed Cause

On October 29, 2026, the maintainer authorized agent fixes, preservation of the
prepared animation, Windows agent restart, read-only device checks and one
controlled physical GIF replacement. Firmware modification, OTA, device reset,
manual flash deletion, safety-limit changes, commit and push were prohibited.

The WSL checkout was clean on `fix/spotify-marquee-gif-loop` at
`1185faa89a362bc180ca9a7eb78e43367e1a0433`. It already contained the native
`node:http` bodyless-request fix and its real HTTP regressions. The Windows
checkout's Git HEAD was `3c5ffe5a1354877b2152a61ce9bbfa419b0e0f94`, with copied
files rather than a clean matching checkout. Its source/client artifact matched
WSL byte-for-byte, but the live process did not reload those files.

Windows PID 24504 served port 8787 using Node.js 22.4.0 and
`C:\Cristian\Projetos\NeonByte\agent\dist\main.js`. It started at 18:39:37 UTC;
the corrected Windows `dist/device/client.js` was written at 19:16:14 UTC.
Replacing an artifact on disk did not update the module already loaded by Node.
The corrected client artifact SHA-256 is
`8f9a26acea3ce705aaad18f03237f38f44aa4363470ba9ea4534e5ab434b601d`.

## Connectivity Evidence

The legacy credential-manager device address was `192.168.68.66`. Both existing
status and capabilities reads to that address reached a 12-second deadline,
without an HTTP response; its neighbor entry was unresolved. The effective
address used by the dashboard was the authenticated maintenance address
`192.168.68.72`. That device answered status and authenticated capabilities with
HTTP 200 in approximately 181 and 170 ms. Its status identified its IP as `.72`.
It advertised NBIF v2, 60 frames, 1,024-byte chunks, a 32,768-byte reserve and
868,352 free bytes. These responses, rather than the dashboard's connection
label, established connectivity. No credential entry or device network setting
was changed.

## Preservation and Minimal Agent Change

The current panel exported its prepared NBIF through `GET /api/animation` before
any restart. The saved file is exactly 53,489 bytes, 240 by 240 pixels, 14 frames
and 1,400 ms, with SHA-256
`18463a47694680e1fa72b74b1fea74b5687e3b621e8b1a4622314da74b1e8bd8`.

The new loopback-only `POST /api/animation/prepared` restores exported NBIF v2
bytes without a GIF conversion. It requires the exported media type and hash,
checks the existing file-size limit and complete format, and honors host,
origin and OTA locks. Invalid input preserves the existing preview. Restoration
stages local media only; device replacement remains a separate action. Optional
bounded original-size metadata preserves preview statistics. See
[the local restore API](development.md#preserving-a-prepared-animation-during-agent-repair).

Only the reviewed agent source/tests and differing build artifacts were copied
to Windows. The prior artifacts were retained outside Git. Credential-manager
fingerprints and the existing `.env` digest matched before and after restart.
The original GIF was neither selected again nor reconverted.

## Controlled Physical Upload

A real TCP fixture running the corrected Windows artifact confirmed
`DELETE /api/v2/animation HTTP/1.1`, bearer authentication, `Content-Length: 0`
and no `Transfer-Encoding`. Requests used keep-alive; firmware responses closed
the connection, which both client transports support. The firmware parser
requires `Host`, HTTP/1.1, a unique explicit length on mutations, no chunked
framing and no `Expect`. The corrected request meets those requirements.

After the corrected agent started as PID 24216, status and capabilities were
read again before one panel `POST /api/animation/replace`. The existing flow
then performed its own preflight. Exactly one removal succeeded with HTTP 200
and reported 1,105,920 free bytes. A new upload session, `00fbd49d`, was admitted
with HTTP 201. A sanitized socket-write trace captured the 95-byte session
request and all 53 authenticated chunks: 52 chunks of 1,024 bytes and a final
241-byte chunk, each with an explicit length and no transfer encoding.

The firmware status progressed through `verifying` to this HTTP 200 response
at 19:26:38 UTC (16:26:38 in America/Sao_Paulo):

~~~json
{
  "uploadId": "00fbd49d",
  "state": "installed",
  "nextOffset": 53489,
  "expectedBytes": 53489,
  "receivedBytes": 53489,
  "error": ""
}
~~~

The production firmware reaches `installed` only after complete SHA-256
verification, independent NBIF decoding and promotion. The panel reached
`complete` on its first attempt after restart, approximately 4.1 seconds after
starting the action. No second DELETE or physical upload was attempted. The
native bodyless requests were validated in the TCP fixture; the physical trace
captured the session/chunks/status, while the agent's validated removal receipt
and terminal state confirmed the successful physical DELETE/complete path.

Temporary tracing was removed by restarting only the Windows agent through its
unchanged scheduled task. The saved preview was restored again without another
device replacement. A restored preview is locally `prepared`; the retained
physical receipt records the completed installation. No firmware was rebuilt,
modified, flashed, updated or restarted. The maintainer then explicitly confirmed that the GIF was appearing and
animating on the physical screen. This visual confirmation complements the
firmware installation receipt; it does not establish endurance or reboot
persistence.

## Validation

- `npm run check`: Markdown, language, contracts, build, types and agent tests;
  agent results were 159 passed and two platform-specific skips.
- Focused HTTP/upload/web tests on native Windows Node.js 22.4.0: 30 passed.
- Offline integration: 25 passed normally and 25 with ASan/UBSan.
- Native firmware: 133 passed and one optional real-fixture skip, normally and
  with ASan/UBSan. The temporary sanitizer configuration initially failed to
  link because the native build did not forward `-no-pie`; explicitly adding
  the sanitizer/non-PIE linker flags corrected the test setup, then all suites
  passed. Repository firmware configuration was unchanged.
- NBIF v2 route and HTTP lifecycle probes passed with ASan/UBSan, covering hash,
  validation, removal, promotion and interrupted-connection behavior.
- A read-only independent review found no Critical or Important issue. It noted
  minor optional test gaps for direct device staging, omitted original size
  and wrong media type. The physical panel test exercised actual staging and
  explicit replacement; the additional optional cases remain deferred.

This targeted result does not complete unrelated hardware, recovery, endurance,
reboot persistence or production-readiness acceptance items in `PLANNING.md`.
