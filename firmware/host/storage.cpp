#include "storage.h"
#include "neonbyte/protocol.h"
#include <openssl/evp.h>
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace neonbyte::host {
std::string hex(std::string_view value) {
    constexpr char DIGITS[] = "0123456789abcdef";
    std::string result;
    for (unsigned char byte : value) { result += DIGITS[byte >> 4]; result += DIGITS[byte & 15]; }
    return result;
}
std::string unhex(std::string_view value) {
    std::string result;
    for (std::size_t i = 0; i + 1 < value.size(); i += 2)
        result += static_cast<char>(std::stoul(std::string(value.substr(i, 2)), nullptr, 16));
    return result;
}
Digest::Digest() : context_(EVP_MD_CTX_new()) { if (!context_) throw std::runtime_error("Digest allocation failed."); reset(); }
Digest::~Digest() { EVP_MD_CTX_free(static_cast<EVP_MD_CTX*>(context_)); }
void Digest::reset() { if (!EVP_DigestInit_ex(static_cast<EVP_MD_CTX*>(context_), EVP_sha256(), nullptr)) throw std::runtime_error("Digest initialization failed."); }
void Digest::update(const std::uint8_t* bytes, std::size_t length) {
    if (!EVP_DigestUpdate(static_cast<EVP_MD_CTX*>(context_), bytes, length)) throw std::runtime_error("Digest update failed.");
}
void Digest::finish(char* out) {
    unsigned char bytes[32]; unsigned length = 0;
    if (!EVP_DigestFinal_ex(static_cast<EVP_MD_CTX*>(context_), bytes, &length) || length != 32) throw std::runtime_error("Digest finalization failed.");
    const auto value = hex({reinterpret_cast<const char*>(bytes), 32}); std::copy(value.begin(), value.end(), out);
}
std::uint32_t FileSource::size() const { return fs::exists(path_) ? fs::file_size(path_) : 0; }
bool FileSource::readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const {
    std::ifstream file(path_, std::ios::binary);
    return file && offset <= size() && length <= size() - offset && file.seekg(offset) &&
        bool(file.read(reinterpret_cast<char*>(out), length));
}
namespace {
class Replacement final : public AtomicFileBackend {
public:
    Replacement(DiskStorage& disk, std::string name) : disk_(disk), name_(std::move(name)), source_(disk.directory / (name_ + ".part")) {}
    bool writeCandidate(const std::uint8_t* bytes, std::size_t length) override {
        if (!disk_.mounted || !disk_.writeOk || disk_.freeBytes() < length + 32768) return false;
        std::ofstream out(disk_.directory / (name_ + ".part"), std::ios::binary);
        out.write(reinterpret_cast<const char*>(bytes), length); out.close(); return bool(out);
    }
    std::uint32_t size() const override { return source_.size(); }
    bool readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override { return disk_.readOk && source_.readAt(offset, out, length); }
    bool promoteCandidate() override {
        if (!disk_.promoteOk) return false;
        std::error_code error; fs::rename(disk_.directory / (name_ + ".part"), disk_.directory / name_, error); return !error;
    }
    void discardCandidate() override { fs::remove(disk_.directory / (name_ + ".part")); }
private:
    DiskStorage& disk_;
    std::string name_;
    FileSource source_;
};
class AnimationStorageAdapter final : public Storage {
public:
    explicit AnimationStorageAdapter(const ImageSource& source) : source_(source) {}
    bool loadMode(DisplayMode&) const override { return false; }
    bool saveMode(DisplayMode) override { return false; }
    std::uint64_t freeBytes() const override { return 0; }
    std::uint32_t animationSize() const override { return source_.size(); }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override { return source_.readAt(offset, out, length); }
private:
    const ImageSource& source_;
};
}
DiskStorage::DiskStorage(fs::path path) : directory(std::move(path)) {}
bool DiskStorage::mountForConfiguration() {
    if (!fs::exists(directory) || !fs::is_directory(directory)) return false;
    mounted = true;
    return true;
}
bool DiskStorage::mount() {
    fs::create_directories(directory);
    for (const auto& entry : fs::directory_iterator(directory))
        if (entry.path().extension() == ".part") fs::remove(entry.path());
    mounted = true;
    return true;
}
bool DiskStorage::replace(const std::string& name, const std::uint8_t* bytes, std::size_t length) {
    Replacement backend(*this, name); return replaceAtomicFile(backend, bytes, length);
}
bool DiskStorage::loadMode(DisplayMode& mode) const {
    std::uint8_t bytes[2]; FileSource file(directory / "mode.bin");
    if (!mounted || !readOk || file.size() != 2 || !file.readAt(0, bytes, 2) || bytes[0] != 'N' || bytes[1] > 2) return false;
    mode = static_cast<DisplayMode>(bytes[1]); return true;
}
bool DiskStorage::saveMode(DisplayMode mode) {
    const std::uint8_t bytes[] = {'N', static_cast<std::uint8_t>(mode)};
    return isValidMode(mode) && replace("mode.bin", bytes, 2);
}
std::uint64_t DiskStorage::freeBytes() const {
    if (!mounted) return 0;
    std::uint64_t used = 0;
    for (const auto& entry : fs::directory_iterator(directory)) used += entry.file_size();
    return used < capacity ? capacity - used : 0;
}
std::uint32_t DiskStorage::animationSize() const { return mounted ? FileSource(directory / "animation.nbif").size() : 0; }
bool DiskStorage::readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const {
    return mounted && readOk && FileSource(directory / "animation.nbif").readAt(offset, out, length);
}
bool DiskStorage::select(bool cover, std::string_view encodedTrack) {
    isCover = cover; track = {}; return !cover || decodeTrackId(encodedTrack, track);
}
bool DiskStorage::begin(std::uint32_t length) {
    const auto overhead = isCover ? 2 + MAX_TEXT_UTF8_BYTES : 0;
    if (!mounted || !writeOk || freeBytes() < length + overhead + 32768) return false;
    candidate.open(directory / stagedName(), std::ios::binary);
    if (isCover) {
        const char lengthBytes[] = {static_cast<char>(track.length), static_cast<char>(track.length >> 8)};
        candidate.write(lengthBytes, 2); candidate.write(track.bytes.data(), track.bytes.size());
    }
    return bool(candidate);
}
bool DiskStorage::write(const std::uint8_t* bytes, std::size_t length) {
    if (!writeOk) return false;
    candidate.write(reinterpret_cast<const char*>(bytes), length); return bool(candidate);
}
void DiskStorage::seal() { candidate.flush(); candidate.close(); }
bool DiskStorage::commit() {
    if (candidate.is_open() || !promoteOk) return false;
    std::error_code error; fs::rename(directory / stagedName(), directory / installedName(), error); return !error;
}
void DiskStorage::abort() { if (candidate.is_open()) candidate.close(); fs::remove(directory / stagedName()); }
bool DiskStorage::validate() const {
    if (!readOk) return false;
    FileSource file(directory / stagedName());
    if (!isCover) { AnimationStorageAdapter storage(file); AnimationReader reader(storage); AnimationMetadata metadata; return reader.open(metadata); }
    std::uint8_t header[9]; const std::uint8_t expected[] = {'N','B','I','C',1,240,0,240,0};
    return file.size() == 2 + MAX_TEXT_UTF8_BYTES + COVER_BYTES && file.readAt(2 + MAX_TEXT_UTF8_BYTES, header, 9) && !std::memcmp(header, expected, 9);
}
std::string DiskStorage::hash(const std::string& name, std::uint32_t prefix) const {
    FileSource source(directory / name);
    if (!mounted || !readOk || source.size() < prefix || !source.size()) return "";
    Digest digest; HashJob job(source, digest, prefix, source.size() - prefix);
    std::uint8_t buffer[512]; HashStep result;
    do { result = job.step(buffer, sizeof(buffer)); } while (result == HashStep::pending);
    if (result == HashStep::failed) return "";
    char value[64]; digest.finish(value); return {value, sizeof(value)};
}
std::string DiskStorage::coverTrackId() const {
    FileSource source(directory / "cover.nbic"); std::uint8_t length[2];
    if (!mounted || !readOk || !source.readAt(0, length, 2)) return "";
    const unsigned count = length[0] | (length[1] << 8);
    if (count > MAX_TEXT_UTF8_BYTES) return "";
    std::string text(count, '\0');
    return source.readAt(2, reinterpret_cast<std::uint8_t*>(text.data()), count) ? text : "";
}
int DiskStorage::coverPixel(std::string_view trackId) const {
    if (trackId.empty() || coverTrackId() != trackId) return -1;
    std::uint8_t bytes[2];
    return FileSource(directory / "cover.nbic").readAt(2 + MAX_TEXT_UTF8_BYTES + 9, bytes, 2) ? bytes[0] | (bytes[1] << 8) : -1;
}
} // namespace neonbyte::host
