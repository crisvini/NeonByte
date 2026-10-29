#define ARDUINO_ARCH_ESP8266 1
#define NEONBYTE_ENABLE_DISPLAY 1

#include "neonbyte/esp8266/display.h"
#ifndef NEONBYTE_DISPLAY_SOURCE
#define NEONBYTE_DISPLAY_SOURCE "../../src/esp8266/display.cpp"
#endif
#include NEONBYTE_DISPLAY_SOURCE
#include <unity.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

using namespace neonbyte;

namespace {
class TestClock final : public Clock {
public:
    std::uint64_t now = 0;
    std::uint64_t monotonicMillis() const override { return now; }
    std::uint64_t unixMillis() const override { return 0; }
};

void put16(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint16_t value) {
    bytes[at] = static_cast<std::uint8_t>(value);
    bytes[at + 1] = static_cast<std::uint8_t>(value >> 8);
}
void put32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
    put16(bytes, at, static_cast<std::uint16_t>(value));
    put16(bytes, at + 2, static_cast<std::uint16_t>(value >> 16));
}
void appendRow(std::vector<std::uint8_t>& bytes, unsigned y, unsigned x, unsigned width,
               unsigned codec, const std::vector<std::uint8_t>& payload) {
    const auto at = bytes.size();
    bytes.resize(at + 6);
    bytes[at] = static_cast<std::uint8_t>(y); bytes[at + 1] = static_cast<std::uint8_t>(x);
    bytes[at + 2] = static_cast<std::uint8_t>(width); bytes[at + 3] = static_cast<std::uint8_t>(codec);
    put16(bytes, at + 4, static_cast<std::uint16_t>(payload.size()));
    bytes.insert(bytes.end(), payload.begin(), payload.end());
}

// The keyframe exercises every codec, including full 480-byte raw payloads.
void installAnimation(PersistentStorage& storage, unsigned frames, std::uint16_t finalDelay = 200) {
    auto& bytes = storage.animationBytes;
    bytes.assign(24 + frames * 20, 0);
    bytes[0] = 'N'; bytes[1] = 'B'; bytes[2] = 'I'; bytes[3] = 'F'; bytes[4] = 2;
    put16(bytes, 6, 240); put16(bytes, 8, 240); put16(bytes, 10, frames);
    for (unsigned frame = 0; frame < frames; ++frame) {
        const auto offset = bytes.size();
        const auto directory = 24 + frame * 20;
        if (frame == 0) {
            bytes.insert(bytes.end(), {0, 0xf8, 0xe0, 7, 0x1f, 0, 0xff, 0xff});
            for (unsigned y = 0; y < 240; ++y) {
                std::vector<std::uint8_t> payload;
                switch (y % 4) {
                    case 0:
                        for (unsigned x = 0; x < 120; ++x)
                            payload.insert(payload.end(), {0, 0xf8, 0x1f, 0});
                        appendRow(bytes, y, 0, 240, 0, payload); break;
                    case 1: appendRow(bytes, y, 0, 240, 1, {0xff, 0xe0, 7, 0xef, 0x1f, 0}); break;
                    case 2: appendRow(bytes, y, 0, 240, 2, std::vector<std::uint8_t>(60, 0x1b)); break;
                    case 3: appendRow(bytes, y, 0, 240, 3, {0xff, 3, 0xef, 0}); break;
                }
            }
            bytes[directory + 11] = 2;
            put16(bytes, directory + 12, 4); put16(bytes, directory + 14, 240);
        } else if (frame + 1 != frames) {
            // Every dependent delta replaces the same two pixels.
            const auto color = frame % 2 ? 0x07e0 : 0x001f;
            appendRow(bytes, 10, 20, 2, 1,
                {0x81, static_cast<std::uint8_t>(color), static_cast<std::uint8_t>(color >> 8)});
            bytes[directory + 10] = 1; put16(bytes, directory + 14, 1);
        } else bytes[directory + 10] = 2;
        put32(bytes, directory, offset); put32(bytes, directory + 4, bytes.size() - offset);
        put16(bytes, directory + 8, frame + 1 == frames ? finalDelay : 50);
    }
    put32(bytes, 12, (frames - 1) * 50 + finalDelay); put32(bytes, 16, bytes.size());
}

std::uint16_t keyframePixel(unsigned x, unsigned y) {
    constexpr std::uint16_t palette[] = {0xf800, 0x07e0, 0x001f, 0xffff};
    if (y % 4 == 0) return x % 2 == 0 ? 0xf800 : 0x001f;
    if (y % 4 == 1) return x < 128 ? 0x07e0 : 0x001f;
    if (y % 4 == 2) return palette[x % 4];
    return x < 128 ? 0xffff : 0xf800;
}
void assertCanvas(unsigned lastDelta) {
    const auto& canvas = display_test::panelState.pixels;
    for (unsigned y = 0; y < 240; ++y) for (unsigned x = 0; x < 240; ++x) {
        const auto expected = lastDelta && y == 10 && (x == 20 || x == 21)
            ? (lastDelta % 2 ? 0x07e0 : 0x001f) : keyframePixel(x, y);
        TEST_ASSERT_EQUAL_HEX16(expected, canvas[y * 240 + x]);
    }
}

void drawFrame(DeviceDisplay& display, SceneManager& scenes, unsigned frame, unsigned frames,
               std::uint64_t now) {
    auto& rows = display_test::panelState.rows;
    rows.clear();
    const auto expectedRows = frame == 0 ? 240u : frame + 1 == frames ? 0u : 1u;
    if (expectedRows) {
        for (unsigned tick = 0; tick < 260 && rows.size() < expectedRows; ++tick) display.tick(scenes, now);
        TEST_ASSERT_EQUAL_UINT(expectedRows, rows.size());
        display.tick(scenes, now); // Complete the record after the last row.
    } else {
        for (unsigned tick = 0; tick < 4; ++tick) display.tick(scenes, now);
        TEST_ASSERT_TRUE(rows.empty());
    }
    assertCanvas(frame + 1 == frames ? frames - 2 : frame);
}

void testRepeatedLoopTransitionsPreserveAllPixelsAndFinalDelay() {
    for (const unsigned frames : {14u, 20u, 48u, 60u}) {
        for (const std::uint16_t finalDelay : {std::uint16_t(20), std::uint16_t(1000)}) {
            display_test::panelState = {};
            PersistentStorage storage; installAnimation(storage, frames, finalDelay);
            TestClock clock; SceneManager scenes(clock, storage);
            TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
            DeviceDisplay display(storage); display.begin();
            std::uint64_t now = 0;
            drawFrame(display, scenes, 0, frames, now);
            for (unsigned loop = 0; loop < 10; ++loop) {
                for (unsigned frame = 1; frame < frames; ++frame) {
                    now += 50;
                    drawFrame(display, scenes, frame, frames, now);
                }
                auto& rows = display_test::panelState.rows;
                rows.clear();
                const auto beforeDeadlineReads = storage.animationReadCalls;
                display.tick(scenes, now + finalDelay - 1);
                TEST_ASSERT_TRUE(rows.empty());
                TEST_ASSERT_EQUAL_UINT(beforeDeadlineReads, storage.animationReadCalls);

                now += finalDelay;
                std::uint64_t simulatedNow = now;
                storage.simulatedReadClock = &simulatedNow;
                storage.simulatedReadDelayMs = 1;
                const auto beforeReads = storage.animationReadCalls;
                const auto beforeBytes = storage.animationReadBytes;
                unsigned ticks = 0, firstRowTicks = 0;
                while (rows.size() < 240 && ticks < 260) {
                    clock.now = simulatedNow;
                    const auto previousRows = rows.size();
                    display.tick(scenes, simulatedNow);
                    TEST_ASSERT_LESS_OR_EQUAL_UINT(previousRows + 1, rows.size());
                    ++ticks; ++simulatedNow;
                    if (!firstRowTicks && !rows.empty()) firstRowTicks = ticks;
                }
                storage.simulatedReadClock = nullptr;
                TEST_ASSERT_EQUAL_UINT(240, rows.size());
                assertCanvas(0);
                const auto reads = storage.animationReadCalls - beforeReads;
                const auto bytes = storage.animationReadBytes - beforeBytes;
                if (loop == 0) std::printf(
                    "LOOP_METRIC frames=%u final_delay_ms=%u reads=%u bytes=%u ticks=%u first_row_ticks=%u simulated_ms=%llu\n",
                    frames, finalDelay, reads, bytes, ticks, firstRowTicks,
                    static_cast<unsigned long long>(simulatedNow - now));
#ifndef NEONBYTE_LOOP_MEASUREMENT_ONLY
                TEST_ASSERT_LESS_OR_EQUAL_UINT(303, reads);
                TEST_ASSERT_LESS_OR_EQUAL_UINT(242, ticks);
                TEST_ASSERT_LESS_OR_EQUAL_UINT(3, firstRowTicks);
#endif
                TEST_ASSERT_LESS_OR_EQUAL_UINT(480, storage.largestAnimationRead);
                display.tick(scenes, simulatedNow); // Finish frame zero.
                now = simulatedNow + 50; // Start the next pass after frame zero's deadline.
            }
            TEST_ASSERT_EQUAL_UINT(1, display_test::panelState.screenClears);
        }
    }
}

void testDecoderRestartPreservesEveryDelayAndDiscardsPendingRows() {
    for (const unsigned frames : {14u, 20u, 48u, 60u}) {
        PersistentStorage storage; installAnimation(storage, frames, 1000);
        std::array<std::uint8_t, 480> output{}, encoded{};
        AnimationDecoder decoder(storage, output.data(), output.size(), encoded.data(), encoded.size());
        AnimationV2Metadata metadata;
        TEST_ASSERT_TRUE(decoder.open(metadata));
        for (unsigned loop = 0; loop < 10; ++loop) {
            unsigned complete = 0;
            for (unsigned step = 0; step < 1000; ++step) {
                const auto status = decoder.step();
                TEST_ASSERT_NOT_EQUAL(AnimationDecodeStatus::Error, status);
                if (status == AnimationDecodeStatus::AnimationComplete) break;
                if (status == AnimationDecodeStatus::RowReady) decoder.consumeRow();
                if (status == AnimationDecodeStatus::FrameComplete) {
                    TEST_ASSERT_EQUAL_UINT(complete, decoder.frameInfo().frameIndex);
                    TEST_ASSERT_EQUAL_UINT(complete + 1 == frames ? 1000 : 50, decoder.frameInfo().delayMs);
                    ++complete;
                }
            }
            TEST_ASSERT_EQUAL_UINT(frames, complete);
            decoder.restart();
        }
        while (decoder.step() == AnimationDecodeStatus::Progress) {}
        TEST_ASSERT_EQUAL_UINT(0, decoder.row().y);
        decoder.consumeRow();
        while (decoder.step() == AnimationDecodeStatus::Progress) {}
        TEST_ASSERT_EQUAL_UINT(1, decoder.row().y);
        decoder.restart(); // Discard an unconsumed row and its prefetched successor.
        while (decoder.step() == AnimationDecodeStatus::Progress) {}
        TEST_ASSERT_EQUAL_UINT(0, decoder.row().y);
        TEST_ASSERT_EQUAL_UINT(0xf800, decoder.row().pixels[0] | (decoder.row().pixels[1] << 8));
    }
}

void testEveryKeyframeReadFailureCanReopenWithoutStalePrefetchedPixels() {
    PersistentStorage storage; installAnimation(storage, 14);
    struct GuardedRow {
        std::uint32_t before = 0x12345678;
        std::array<std::uint8_t, 480> bytes{};
        std::uint32_t after = 0x87654321;
    } output, encoded;
    AnimationDecoder decoder(storage, output.bytes.data(), output.bytes.size(), encoded.bytes.data(), encoded.bytes.size());
    AnimationV2Metadata metadata;
    TEST_ASSERT_TRUE(decoder.open(metadata));
    const auto openedReads = storage.animationReadCalls;
    while (true) {
        const auto status = decoder.step();
        TEST_ASSERT_NOT_EQUAL(AnimationDecodeStatus::Error, status);
        if (status == AnimationDecodeStatus::FrameComplete) break;
        if (status == AnimationDecodeStatus::RowReady) decoder.consumeRow();
    }
    const auto keyframeReads = storage.animationReadCalls - openedReads;
    for (unsigned failure = 1; failure <= keyframeReads; ++failure) {
        TEST_ASSERT_TRUE(decoder.open(metadata));
        storage.failAnimationReadCall = storage.animationReadCalls + failure;
        AnimationDecodeStatus status = AnimationDecodeStatus::Progress;
        for (unsigned step = 0; step < 260; ++step) {
            status = decoder.step();
            if (status == AnimationDecodeStatus::Error || status == AnimationDecodeStatus::FrameComplete) break;
            if (status == AnimationDecodeStatus::RowReady) decoder.consumeRow();
        }
        TEST_ASSERT_EQUAL_INT(AnimationDecodeStatus::Error, status);
        TEST_ASSERT_FALSE(decoder.valid());
        storage.failAnimationReadCall = 0;
        TEST_ASSERT_TRUE(decoder.open(metadata));
        unsigned rows = 0;
        for (unsigned step = 0; step < 260; ++step) {
            status = decoder.step();
            TEST_ASSERT_NOT_EQUAL(AnimationDecodeStatus::Error, status);
            if (status == AnimationDecodeStatus::FrameComplete) break;
            if (status == AnimationDecodeStatus::RowReady) {
                const auto row = decoder.row();
                TEST_ASSERT_EQUAL_UINT(rows, row.y);
                for (unsigned x = 0; x < 240; ++x)
                    TEST_ASSERT_EQUAL_HEX16(keyframePixel(x, rows), row.pixels[x * 2] | (row.pixels[x * 2 + 1] << 8));
                ++rows;
                decoder.consumeRow();
            }
        }
        TEST_ASSERT_EQUAL_UINT(240, rows);
        TEST_ASSERT_EQUAL_HEX32(0x12345678, output.before); TEST_ASSERT_EQUAL_HEX32(0x87654321, output.after);
        TEST_ASSERT_EQUAL_HEX32(0x12345678, encoded.before); TEST_ASSERT_EQUAL_HEX32(0x87654321, encoded.after);
    }
}

void testLoopDirectoryReadFailureRecoversAtTheFirstKeyframe() {
    display_test::panelState = {};
    PersistentStorage storage; installAnimation(storage, 14, 20);
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    std::uint64_t now = 0;
    for (unsigned frame = 0; frame < 14; ++frame) {
        drawFrame(display, scenes, frame, 14, now);
        if (frame + 1 != 14) now += 50;
    }
    auto& rows = display_test::panelState.rows;
    rows.clear();
    storage.failAnimationReadCall = storage.animationReadCalls + 1;
    // The baseline's idle tick precedes this directory read. Allow both ticks
    // so this regression checks safe failure/recovery with either scheduler.
    display.tick(scenes, now + 20);
    if (storage.animationReadCalls < storage.failAnimationReadCall) display.tick(scenes, now + 20);
    TEST_ASSERT_EQUAL_UINT(storage.failAnimationReadCall, storage.animationReadCalls);
    TEST_ASSERT_TRUE(rows.empty());
    storage.failAnimationReadCall = 0;
    for (unsigned tick = 0; tick < 270 && rows.size() < 240; ++tick) display.tick(scenes, now + 21);
    TEST_ASSERT_EQUAL_UINT(240, rows.size());
    assertCanvas(0);
}

void testOptionalRealAnimationLoopsMatchEveryOraclePixel() {
    const auto* fixture = std::getenv("NEONBYTE_LOOP_FIXTURE");
    if (!fixture) TEST_IGNORE_MESSAGE("Set NEONBYTE_LOOP_FIXTURE to the generated local fixture directory.");
    const auto readFile = [](const std::string& path) {
        std::ifstream input(path, std::ios::binary);
        return std::vector<std::uint8_t>(std::istreambuf_iterator<char>(input), {});
    };
    display_test::panelState = {};
    PersistentStorage storage;
    storage.animationBytes = readFile(std::string(fixture) + "/animation.nbif");
    const auto oracle = readFile(std::string(fixture) + "/animation.rgb565");
    TEST_ASSERT_GREATER_THAN_UINT(24, storage.animationBytes.size());
    const auto read16 = [&](std::size_t at) {
        return storage.animationBytes[at] | (storage.animationBytes[at + 1] << 8);
    };
    const unsigned frames = read16(10);
    TEST_ASSERT_EQUAL_UINT(frames * 115200, oracle.size());
    TestClock clock; SceneManager scenes(clock, storage);
    TEST_ASSERT_TRUE(scenes.setMode(DisplayMode::gif));
    DeviceDisplay display(storage); display.begin();
    auto& rows = display_test::panelState.rows;
    const auto checkPixels = [&](unsigned frame) {
        for (unsigned pixel = 0; pixel < 57600; ++pixel) {
            const auto offset = frame * 115200 + pixel * 2;
            TEST_ASSERT_EQUAL_HEX16(oracle[offset] | (oracle[offset + 1] << 8), display_test::panelState.pixels[pixel]);
        }
    };
    std::uint64_t now = 0;
    for (unsigned loop = 0; loop < 10; ++loop) {
        // The preceding seam has already rendered frame zero on later passes.
        for (unsigned frame = loop == 0 ? 0 : 1; frame < frames; ++frame) {
            rows.clear();
            const unsigned count = read16(24 + frame * 20 + 14);
            if (count) {
                for (unsigned tick = 0; tick < 270 && rows.size() < count; ++tick) display.tick(scenes, now);
                TEST_ASSERT_EQUAL_UINT(count, rows.size());
                display.tick(scenes, now);
            } else for (unsigned tick = 0; tick < 4; ++tick) display.tick(scenes, now);
            checkPixels(frame);
            if (frame + 1 != frames) now += read16(24 + frame * 20 + 8);
        }
        rows.clear();
        const auto finalDelay = read16(24 + (frames - 1) * 20 + 8);
        const auto beforeReads = storage.animationReadCalls;
        display.tick(scenes, now + finalDelay - 1);
        TEST_ASSERT_TRUE(rows.empty());
        TEST_ASSERT_EQUAL_UINT(beforeReads, storage.animationReadCalls);
        now += finalDelay;
        std::uint64_t simulatedNow = now;
        storage.simulatedReadClock = &simulatedNow; storage.simulatedReadDelayMs = 1;
        unsigned ticks = 0, firstRowTicks = 0;
        const auto beforeBytes = storage.animationReadBytes;
        while (rows.size() < 240 && ticks < 270) {
            const auto previousRows = rows.size();
            display.tick(scenes, simulatedNow);
            TEST_ASSERT_LESS_OR_EQUAL_UINT(previousRows + 1, rows.size());
            ++ticks; ++simulatedNow;
            if (!firstRowTicks && !rows.empty()) firstRowTicks = ticks;
        }
        storage.simulatedReadClock = nullptr;
        TEST_ASSERT_EQUAL_UINT(240, rows.size());
        checkPixels(0);
        if (loop == 0) std::printf(
            "REAL_LOOP_METRIC frames=%u final_delay_ms=%u reads=%u bytes=%u ticks=%u first_row_ticks=%u simulated_ms=%llu\n",
            frames, finalDelay, storage.animationReadCalls - beforeReads,
            storage.animationReadBytes - beforeBytes, ticks, firstRowTicks,
            static_cast<unsigned long long>(simulatedNow - now));
        display.tick(scenes, simulatedNow);
        now = simulatedNow + read16(24 + 8);
    }
    TEST_ASSERT_EQUAL_UINT(1, display_test::panelState.screenClears);
    display.showSpotifyWaiting();
    rows.clear();
    for (unsigned tick = 0; tick < 270 && rows.size() < 240; ++tick) display.tick(scenes, now);
    TEST_ASSERT_EQUAL_UINT(240, rows.size());
    checkPixels(0);
}
} // namespace

int main() {
    UNITY_BEGIN();
    RUN_TEST(testRepeatedLoopTransitionsPreserveAllPixelsAndFinalDelay);
    RUN_TEST(testDecoderRestartPreservesEveryDelayAndDiscardsPendingRows);
    RUN_TEST(testEveryKeyframeReadFailureCanReopenWithoutStalePrefetchedPixels);
    RUN_TEST(testLoopDirectoryReadFailureRecoversAtTheFirstKeyframe);
    RUN_TEST(testOptionalRealAnimationLoopsMatchEveryOraclePixel);
    return UNITY_END();
}
