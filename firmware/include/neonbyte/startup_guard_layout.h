#pragma once

#include <cstddef>
#include <cstdint>

namespace neonbyte {
constexpr std::uint32_t RTC_USER_MEMORY_CAPACITY_BYTES = 512;
constexpr std::uint32_t EBOOT_RESERVED_RTC_BYTES = 128;
constexpr std::uint32_t STARTUP_GUARD_LAYOUT_VERSION = 1;
constexpr std::uint32_t STARTUP_GUARD_MAGIC_PREFIX = 0x4e425300;
constexpr std::uint32_t STARTUP_GUARD_MAGIC = STARTUP_GUARD_MAGIC_PREFIX | STARTUP_GUARD_LAYOUT_VERSION;
constexpr std::uint32_t STARTUP_GUARD_RTC_WORD_OFFSET = EBOOT_RESERVED_RTC_BYTES / sizeof(std::uint32_t);
constexpr std::uint32_t STARTUP_GUARD_RTC_BYTE_OFFSET = STARTUP_GUARD_RTC_WORD_OFFSET * sizeof(std::uint32_t);
constexpr std::size_t STARTUP_GUARD_RECORD_BYTES = 3 * sizeof(std::uint32_t);

struct StartupGuardRecord {
    std::uint32_t magic;
    std::uint32_t risky;
    std::uint32_t inverse;
};

enum class StartupResetReason { powerOn, softRestart, externalReset, unexpected };

static_assert(STARTUP_GUARD_LAYOUT_VERSION <= 0xff);
static_assert(sizeof(StartupGuardRecord) == STARTUP_GUARD_RECORD_BYTES);
static_assert(STARTUP_GUARD_RTC_BYTE_OFFSET >= EBOOT_RESERVED_RTC_BYTES);
static_assert(STARTUP_GUARD_RTC_BYTE_OFFSET + STARTUP_GUARD_RECORD_BYTES <= RTC_USER_MEMORY_CAPACITY_BYTES);

template <typename ReadRecord, typename InitializeCleanGuard>
bool startupResetRequiresMaintenance(StartupResetReason reason, ReadRecord&& readRecord,
                                     InitializeCleanGuard&& initializeCleanGuard) {
    if (reason == StartupResetReason::unexpected) return true;
    StartupGuardRecord record{};
    if (!readRecord(STARTUP_GUARD_RTC_WORD_OFFSET,record)) return true;
    const bool valid = record.magic == STARTUP_GUARD_MAGIC && record.inverse == ~record.risky && record.risky <= 1;
    if (!valid) {
        // RTC contents are unspecified on power-on; initialize only on that clean reset reason.
        if (reason != StartupResetReason::powerOn) return true;
        return !initializeCleanGuard();
    }
    return record.risky != 0;
}
}
