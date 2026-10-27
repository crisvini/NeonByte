# Final Offline Preparation Plan

**Goal:** Implement the separately authenticated legacy restoration path and deliver evidence-based preparation and physical test documents without device access.

**Spec:** [Stock restoration design](../../stock-restore-design.md), the maintainer's current request, `AGENTS.md`, and `PLANNING.md`.

**Constraints:** Preserve modern validators and v1 contracts, existing OTA/deployment guards, filesystem layout and no-autoformat policy. No real secrets, private installation package, device connection, release, or hardware completion claim. Keep NO-GO unless every mandatory gate is evidenced.

## Tasks

- [x] Add failing native legacy validator/admission/geometry/transaction regressions; implement a strict allowlisted legacy validator and immutable transaction policy.
- [x] Bind the separate route to recovery authentication, both feature gates, raw transfer selection, checked readback and existing activation state. Test adapter routing/admission with host doubles.
- [x] Exercise the real unchanged vendor file with real host SHA-256 and modeled flash. Keep modern acceptance/rejection checks unchanged. Test failure cleanup and stock data/RTC preservation.
- [x] Audit maintenance startup, AP/listener, delayed display initialization, resource use, watchdog and preservation; fix only reproduced defects with regression evidence.
- [x] Run all relevant local repository/native/offline/sanitizer/ESP8266 compile/image/guard checks and record exact outcomes.
- [x] Write a pre-installation checklist and progressive physical test proposal with prerequisites, stop conditions, separate authorization boundaries and the first irreversible operation. Record remaining permanent-loss risks and final NO-GO decision.

## Review Focus

- No modern route accepts a legacy image or selects a stock policy.
- No filesystem access, activation or restart occurs after any rejected stock transaction.
- Correct request SHA-256 cannot bypass actual staged-byte verification.
- Existing automatic startup cannot overwrite the eboot RTC command during delayed restart.
- Host proofs are distinguished from actual stock acceptance, radio reachability and boot success.

## Execution Record

Implementation proceeds under the maintainer's explicit offline request. The architecture above is a local implementation choice within that scope. No additional physical or packaging authorization is inferred.

The legacy/parser/admission/transaction tests failed before implementation. The HTTP probe failed against the previous adapter and passed with the new route; its final version also executes body/hash/finalization selection. Native fault tests and real vendor bytes with OpenSSL SHA-256 passed. An independent read-only reviewer found no Critical or Important defect; its optional shared-backend/combined-adapter coverage suggestions were implemented and sanitizer-verified. Actual radio, flash, watchdog, stock boot and power-loss behavior remain outside host evidence. Final results: 74 native tests, 20 offline scenarios, repository checks, applicable sanitizer probes, both existing compile-only profiles, image checks and synthetic deployment guards passed. Installation remains NO-GO.
