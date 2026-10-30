#pragma once

#include <cstddef>
#include <cstdint>

inline std::uint64_t displayTestClockTenthsOfMicrosecond = 0;
inline std::uint32_t displayTestAnimationReadCount = 0;
inline std::uint32_t displayTestCompletedAnimationRows = 0;
inline std::uint32_t displayTestAnimationReadsBetweenRows = 0;
inline std::uint32_t displayTestReadsDuringSpiTransaction = 0;
inline bool displayTestSpiTransactionActive = false;

inline void advanceDisplayTestClockMicroseconds(std::uint32_t microseconds) {
    displayTestClockTenthsOfMicrosecond += static_cast<std::uint64_t>(microseconds) * 10;
}

inline void advanceDisplayTestClockForPixels(std::size_t pixels) {
    displayTestClockTenthsOfMicrosecond += static_cast<std::uint64_t>(pixels) * 8;
}

inline std::uint32_t micros() {
    return static_cast<std::uint32_t>(displayTestClockTenthsOfMicrosecond / 10);
}
