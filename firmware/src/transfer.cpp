#include "neonbyte/transfer.h"
#include <algorithm>
namespace neonbyte {
bool isSha256(std::string_view value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
bool Transfer::begin(std::uint32_t length, std::uint32_t limit, std::string_view hash) {
    if (active_ || length == 0 || length > limit || !isSha256(hash)) return false;
    if (!sink_.begin(length)) { sink_.abort(); return false; }
    std::copy(hash.begin(), hash.end(), expectedHash_.begin());
    length_ = length; received_ = 0; active_ = true; return true;
}
bool Transfer::append(const std::uint8_t* bytes, std::size_t length) {
    if (!active_) return false;
    if (!bytes || length > length_ - received_ || !sink_.write(bytes, length)) {
        abort(); return false;
    }
    received_ += length; return true;
}
bool Transfer::finish(std::string_view actualHash, bool validContent) {
    if (!active_) return false;
    if (received_ != length_ || !validContent || actualHash != std::string_view(expectedHash_.data(), expectedHash_.size()) || !sink_.commit()) {
        abort(); return false;
    }
    active_ = false; return true;
}
void Transfer::abort() { if (active_) sink_.abort(); active_ = false; }
} // namespace neonbyte
