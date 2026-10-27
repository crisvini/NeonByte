#pragma once

// Host-only adapters. Never compiled into a board profile.
#include "neonbyte/animation_reader.h"
#include "neonbyte/atomic_file.h"
#include "neonbyte/hash_job.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/transfer.h"
#include <filesystem>
#include <fstream>
#include <vector>

namespace neonbyte::host {
namespace fs = std::filesystem;

class Digest final : public ContentDigest {
public:
    Digest();
    ~Digest() override;
    void reset() override;
    void update(const std::uint8_t* bytes, std::size_t length) override;
    void finish(char* hex64) override;
private:
    void* context_;
};

class FileSource final : public ImageSource {
public:
    explicit FileSource(fs::path path) : path_(std::move(path)) {}
    std::uint32_t size() const override;
    bool readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override;
private:
    fs::path path_;
};

class DiskStorage final : public Storage, public TransferSink {
public:
    explicit DiskStorage(fs::path directory);
    bool mount();
    bool loadMode(DisplayMode& mode) const override;
    bool saveMode(DisplayMode mode) override;
    std::uint64_t freeBytes() const override;
    std::uint32_t animationSize() const override;
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override;
    bool replace(const std::string& name, const std::uint8_t* bytes, std::size_t length);
    bool select(bool cover, std::string_view encodedTrack);
    bool begin(std::uint32_t length) override;
    bool write(const std::uint8_t* bytes, std::size_t length) override;
    bool commit() override;
    void abort() override;
    void seal();
    bool validate() const;
    std::string hash(const std::string& name, std::uint32_t prefix = 0) const;
    std::string coverTrackId() const;
    int coverPixel(std::string_view trackId) const;
    fs::path directory;
    bool mounted = false, writeOk = true, promoteOk = true, readOk = true;
    std::uint64_t capacity = 4 * 1024 * 1024; // Synthetic capacity; no device claim.
    bool isCover = false;
    FixedText track{};
    std::ofstream candidate;
    std::string stagedName() const { return isCover ? "cover.part" : "animation.part"; }
    std::string installedName() const { return isCover ? "cover.nbic" : "animation.nbif"; }
};

std::string hex(std::string_view value);
std::string unhex(std::string_view value);
} // namespace neonbyte::host
