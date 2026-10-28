# Animation Codec Benchmark

Generated GIF fixtures use 14 full-canvas 240 x 240 frames at 70 ms each. The reference GIF was not supplied. This is a synthetic benchmark; full-motion noise is a worst-case fallback check.

Sizes are encoded file bytes. RAM and timing are not inferred from host measurements. The direct GIF row measures storage only; the ESP8266 has no GIF decoder in the current build.

The SPI columns are pixel-only lower bounds at the current requested 20 MHz clock. They exclude address commands, scheduling, decoder and LittleFS work. A display-row iteration is an estimate from the current one-row-per-loop renderer, not a measured FPS result.

## Resource and Comparison Notes

The reference 14-frame GIF is not in the repository or the request payload, so
these are generated fixtures rather than measurements of that asset. Original
GIF storage is measured directly; this firmware has no GIF/LZW decoder. A
desktop-normalized GIF was not produced because the agent currently has no GIF
encoder. Adding one would add another implementation/dependency to maintain and
would not improve the v2 reader's bounded memory or cooperative scheduling.

On the host ABI, `sizeof(AnimationDecoder)` is 1,480 bytes and
`sizeof(AnimationUploadSession)` is 152 bytes. The playback and validation decoder
contexts, separate 480-byte validation row, upload session, and maximum 1,024-byte
request body total **4,616 bytes** of fixed state/buffer payload. The playback
pixel row already existed in the display path. This excludes C++ object padding
outside those measured types, BearSSL/LittleFS/TCP state, filesystem caches,
runtime stack/heap fragmentation, and any target-specific ABI savings. It is not
a measurement of free ESP8266 heap.

The v2 player sends 448 row spans rather than v1's 3,360 rows on the generated
small-motion animation, and 3,360 spans for full-screen motion. Its pixel-only
SPI lower bound is therefore 50.74 ms per 14-frame small-motion loop versus
645.12 ms for v1, while both remain 645.12 ms on full-screen motion. A full frame
still needs at least 46.08 ms of pixel transfer at the requested 20 MHz. These
figures compare bytes/windows presented to the LCD; they do not include decode
CPU cost or establish ESP8266 frame rate, tearing, or subjective smoothness.

No ESP8266 image was built in this pass: PlatformIO is unavailable in the
environment, and the available target profile includes the private include path.
The target firmware code-size delta, linker RAM report, measured LittleFS cache
cost, runtime free heap, physical frame rate, visual tearing/flicker, and Wi-Fi
latency remain **PENDING**. No physical device was accessed.

| Scenario | Source GIF | Source SHA-256 | NBIF v1 RGB565 | Palette full frames | RGB565 RLE + delta | NBIF v2 | NBIF v2 SHA-256 | Reduction vs v1 | Exact | Changed pixels | V2 rows / V1 rows | V2 pixel bytes | SPI lower bound V2 / V1 |
|---|---:|---|---:|---:|---:|---:|---|---:|---|---:|---:|---:|---:|
| static-hold-14 | 4870 | 5c15b6bad1807b49def06e24546d5a7457fb62b2b59b9ca730e9b0b9c808dace | 1612839 | 121292 | 3184 | 2706 | d4158d09c69aa9a9a8f1936865a8b6a562fb7d44874cddd98d612ead9daf2f2d | 99.83% | true | 0 | 240 / 3360 | 115200 | 46.08 / 645.12 ms |
| small-motion-14 | 5849 | bb4340d1e98c2b91562fba94318eee01262b16dfaab7fa2d18b875c0e62be155 | 1612839 | 222176 | 12496 | 5824 | f0dacf757420f080674cca76a9bc38dd66da54727e219f7c82f5c8096fdab888 | 99.64% | true | 5824 | 448 / 3360 | 126848 | 50.74 / 645.12 ms |
| full-motion-pattern-14 | 54064 | fe2823f9f592fd4b60ccc81f85e648c3b45d9c618a5e71ed19f0e6c87b28175e | 1612839 | 828656 | 1633264 | 828656 | 3a866023f2b344742ccb851963547524ace4edf5fc2a3ce13d605cc7276776ae | 48.62% | true | 748800 | 3360 / 3360 | 1612800 | 645.12 / 645.12 ms |
| full-motion-palette-14 | 23106 | d857f4615fafad6426ad071d59ddeb68cd15a17db3664be71638ac1f6ba05bdb | 1612839 | 424112 | 1633264 | 424112 | cc8c30119075c130e7623cda57285182cc55a09451b32b06a9c3fb47cdaf4b10 | 73.70% | true | 748800 | 3360 / 3360 | 1612800 | 645.12 / 645.12 ms |
| full-motion-noise-14 | 1108215 | b16621fe2f115c74559369f84c95db3fa155bd4c73d899388dd92a633806a143 | 1612839 | 834032 | 1633215 | 834008 | 1f30a3120c05d9a0f8543b3e89a8bc3a65c35b100c86ce5ff4f678ab56bb0ad2 | 48.29% | true | 745943 | 3360 / 3360 | 1612752 | 645.10 / 645.12 ms |

Decoder comparison: direct GIF retains the smallest source bytes but needs an MCU LZW decoder. Upstream AnimatedGIF documents roughly 22 KiB for its no-framebuffer path; no target build or physical timing is included here.
