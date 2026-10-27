#pragma once
#include "neonbyte/ota_staging.h"

#ifndef NEONBYTE_ENABLE_STOCK_RESTORE
#define NEONBYTE_ENABLE_STOCK_RESTORE 0
#endif
#if NEONBYTE_ENABLE_STOCK_RESTORE != 0 && NEONBYTE_ENABLE_STOCK_RESTORE != 1
#error NEONBYTE_ENABLE_STOCK_RESTORE must be 0 or 1
#endif

namespace neonbyte {
constexpr std::uint32_t STOCK_V106_BYTES = 488304;
constexpr std::string_view STOCK_V106_SHA256 = "058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b";
bool isStockRestorePath(std::string_view path);
bool stockRestoreRequestMatches(std::uint32_t length, std::string_view hash);
bool stockRestoreGeometryMatches(const OtaGeometry& geometry);
// Structure/CRC only; the transaction must also verify the pinned SHA-256.
bool validateLegacyStockImage(const ImageSource& source);
OtaAdmissionError stockRestoreAdmission(bool authorized, bool paused, bool otaEnabled, bool restoreEnabled,
    HttpMethod method, std::string_view contentType, std::uint32_t length, std::string_view hash);
} // namespace neonbyte
