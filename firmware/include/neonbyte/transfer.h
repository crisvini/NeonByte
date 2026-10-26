#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <array>
namespace neonbyte {
class TransferSink {
public:
    virtual ~TransferSink() = default;
    virtual bool begin(std::uint32_t length) = 0;
    virtual bool write(const std::uint8_t* bytes, std::size_t length) = 0;
    virtual bool commit() = 0;
    virtual void abort() = 0;
};
class Transfer {
public:
    explicit Transfer(TransferSink& sink) : sink_(sink) {}
    bool begin(std::uint32_t length, std::uint32_t limit, std::string_view hash);
    bool append(const std::uint8_t* bytes, std::size_t length);
    bool finish(std::string_view actualHash, bool validContent);
    void abort();
    bool active() const { return active_; }
    std::uint32_t received() const { return received_; }
private:
    TransferSink& sink_;
    std::array<char, 64> expectedHash_{};
    std::uint32_t length_ = 0, received_ = 0;
    bool active_ = false;
};
bool isSha256(std::string_view value);
} // namespace neonbyte
