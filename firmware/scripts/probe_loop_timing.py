#!/usr/bin/env python3
"""Exercise the production loop's stage timing with deterministic offline time."""

import os
import subprocess
import tempfile
from pathlib import Path

from probe_compatibility import extractFunction


def main():
    repository = Path(__file__).resolve().parents[2]
    adapter = (repository / "firmware/src/esp8266/main.cpp").read_text()
    header = (repository / "firmware/include/neonbyte/esp8266/http_server.h").read_text()
    source = r'''
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
namespace neonbyte {
std::uint32_t timeMs = 0, backgroundCost = 0;
unsigned delays = 0, displayCalls = 0;
struct Clock { std::uint64_t monotonicMillis() { return timeMs; } } deviceClock;
struct Startup {
    bool valid = true, running = true;
    std::uint32_t cost = 0;
    bool identityValid() { return valid; }
    bool applicationRunning() { return running; }
    void tick(std::uint64_t) { timeMs += cost; }
} startup;
struct Http {
    std::uint32_t cost = 0;
    struct Diagnostics {
        std::uint32_t maxHttpTickMs = 0, maxStartupTickMs = 0, maxDisplayTickMs = 0, maxBackgroundMs = 0;
    } diagnostics_;
    void tick(std::uint64_t) { timeMs += cost; }
    void recordLoopTimings(std::uint32_t http, std::uint32_t startup,
                           std::uint32_t display, std::uint32_t background);
} http;
int sceneValue = 0;
int* scenes = &sceneValue;
struct Display {
    std::uint32_t cost = 0;
    void tick(int&, std::uint64_t) { timeMs += cost; ++displayCalls; }
} display;
}
std::uint32_t millis() { return neonbyte::timeMs; }
void delay(unsigned value) {
    assert(value == 0); ++neonbyte::delays; neonbyte::timeMs += neonbyte::backgroundCost;
}
''' + "namespace neonbyte {\n" + extractFunction(header, "void recordLoopTimings(").replace(
        "void recordLoopTimings(", "void Http::recordLoopTimings(", 1) + "\n}\n" + extractFunction(adapter, "void loop()") + r'''
int main() {
    using namespace neonbyte;
    http.cost = 7; startup.cost = 1109; display.cost = 3; backgroundCost = 11;
    loop();
    assert(http.diagnostics_.maxHttpTickMs == 7 && http.diagnostics_.maxStartupTickMs == 1109);
    assert(http.diagnostics_.maxDisplayTickMs == 3 && http.diagnostics_.maxBackgroundMs == 11);
    startup.cost = 1; display.cost = 19;
    loop();
    assert(http.diagnostics_.maxStartupTickMs == 1109 && http.diagnostics_.maxDisplayTickMs == 19);
    // Unsigned millisecond subtraction must survive the hardware clock wrap.
    timeMs = UINT32_MAX - 2; http.cost = 10; backgroundCost = 31;
    loop();
    assert(http.diagnostics_.maxHttpTickMs == 10 && http.diagnostics_.maxBackgroundMs == 31);
    startup.running = false; display.cost = 100;
    loop(); assert(displayCalls == 3 && http.diagnostics_.maxDisplayTickMs == 19);
    startup.running = true; scenes = nullptr;
    loop(); assert(displayCalls == 3);
    startup.valid = false; http.cost = 1000; startup.cost = 2000;
    loop();
    assert(http.diagnostics_.maxHttpTickMs == 10 && http.diagnostics_.maxStartupTickMs == 1109);
    assert(displayCalls == 3 && delays == 6);
    std::puts("Loop timing: stage attribution, accumulation, rollover and inactive paths passed.");
}
'''
    flags = (["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie"]
             if os.environ.get("NEONBYTE_PROBE_SANITIZERS") == "1" else [])
    with tempfile.TemporaryDirectory(prefix="neonbyte-loop-timing-") as directory:
        code, binary = Path(directory) / "probe.cpp", Path(directory) / "probe"
        code.write_text(source, encoding="utf-8")
        subprocess.run([os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra",
                        "-Werror", *flags, str(code), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
