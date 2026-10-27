#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/storage.h"
#include "neonbyte/http_headers.h"
#include "neonbyte/atomic_file.h"
#include "neonbyte/protocol.h"
#include <ESP8266WiFi.h>
#include <Updater.h>
#include <bearssl/bearssl_hash.h>
#include <algorithm>
#include <cstring>
namespace neonbyte {
namespace {
constexpr std::uint32_t SPACE_RESERVE = 32 * 1024;
void digest(const void* data, std::size_t size, std::uint8_t* out) {
    br_sha256_context context; br_sha256_init(&context);
    br_sha256_update(&context,data,size); br_sha256_out(&context,out);
}
class LittleFsReplacement final : public AtomicFileBackend {
public:
    LittleFsReplacement(const char* temporary, const char* installed) : temporary_(temporary), installed_(installed) {}
    bool writeCandidate(const std::uint8_t* data, std::size_t length) override {
        File file = LittleFS.open(temporary_,"w"); if (!file) return false;
        const bool written = file.write(data,length) == length;
        file.flush(); file.close(); return written;
    }
    std::uint32_t size() const override { FileSource file(temporary_); return file.size(); }
    bool readAt(std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const override {
        FileSource file(temporary_); return file.readAt(offset,bytes,length);
    }
    bool promoteCandidate() override { return LittleFS.rename(temporary_,installed_); }
    void discardCandidate() override { LittleFS.remove(temporary_); }
private:
    const char* temporary_;
    const char* installed_;
};
bool atomicWrite(const char* temporary, const char* installed, const void* data, std::size_t length) {
    LittleFsReplacement backend(temporary,installed);
    return replaceAtomicFile(backend,static_cast<const std::uint8_t*>(data),length);
}
class AnimationFile final : public Storage {
public:
    explicit AnimationFile(const ImageSource& source) : source_(source) {}
    bool loadMode(DisplayMode&) const override { return false; }
    bool saveMode(DisplayMode) override { return false; }
    std::uint64_t freeBytes() const override { return 0; }
    std::uint32_t animationSize() const override { return source_.size(); }
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const override { return source_.readAt(offset,out,length); }
private:
    const ImageSource& source_;
};
}
bool FileSource::readAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const {
    yield();
    return file_ && offset <= file_.size() && length <= file_.size()-offset && file_.seek(offset,SeekSet) && file_.read(out,length) == static_cast<int>(length);
}
bool PersistentStorage::beginStorage() {
    LittleFSConfig config; config.setAutoFormat(false); LittleFS.setConfig(config);
    ready = LittleFS.begin();
    if (!ready) return false;
    // This is not a stock filesystem migration. Never format or remove stock paths.
    if (!LittleFS.exists("/neonbyte") && !LittleFS.mkdir("/neonbyte")) { ready = false; return false; }
    LittleFS.remove("/neonbyte/animation.part");
    LittleFS.remove("/neonbyte/cover.part");
    LittleFS.remove("/neonbyte/firmware.part");
    return true;
}
bool PersistentStorage::loadConfiguration() {
    if (!ready) return false;
    File file = LittleFS.open("/neonbyte/config.bin","r");
    if (!file) return false; // First-boot identity is independent of LittleFS.
    DeviceConfiguration candidate{}; std::uint8_t stored[32], actual[32];
    if (file.size() != sizeof(candidate)+sizeof(stored) || file.read(reinterpret_cast<std::uint8_t*>(&candidate),sizeof(candidate)) != sizeof(candidate) || file.read(stored,sizeof(stored)) != sizeof(stored)) return false;
    digest(&candidate,sizeof(candidate),actual);
    if (memcmp(stored,actual,32) || candidate.version != 1 || candidate.ssid[32] || candidate.password[64] || candidate.token[64] || candidate.apPassword[16] || strlen(candidate.token) != 64 || strlen(candidate.apPassword) != 16) return false;
    configuration = candidate; return true;
}
bool PersistentStorage::saveConfiguration(const DeviceConfiguration& value) {
    if (!ready || freeBytes() < SPACE_RESERVE) return false;
    std::array<std::uint8_t,sizeof(DeviceConfiguration)+32> record{};
    memcpy(record.data(),&value,sizeof(value)); digest(&value,sizeof(value),record.data()+sizeof(value));
    if (!atomicWrite("/neonbyte/config.part","/neonbyte/config.bin",record.data(),record.size())) return false;
    configuration = value; return true;
}
bool PersistentStorage::loadMode(DisplayMode& mode) const {
    if (!ready) return false;
    File file = LittleFS.open("/neonbyte/mode.bin","r");
    if (!file || file.size() != 2 || file.read() != 'N') return false;
    const int value = file.read(); if (value < 0 || value > 2) return false;
    mode = static_cast<DisplayMode>(value); return true;
}
bool PersistentStorage::saveMode(DisplayMode mode) {
    if (!ready || !isValidMode(mode) || freeBytes() < SPACE_RESERVE) return false;
    DisplayMode current;
    if (loadMode(current) && current == mode) return true;
    const std::uint8_t bytes[] = {'N', static_cast<std::uint8_t>(mode)};
    return atomicWrite("/neonbyte/mode.part","/neonbyte/mode.bin",bytes,sizeof(bytes));
}
std::uint64_t PersistentStorage::freeBytes() const {
    FSInfo info{}; if (!ready || !LittleFS.info(info) || info.usedBytes > info.totalBytes) return 0;
    return info.totalBytes-info.usedBytes;
}
std::uint32_t PersistentStorage::animationSize() const {
    if (!ready) return 0;
    File file = LittleFS.open("/neonbyte/animation.nbif","r"); return file ? file.size() : 0;
}
bool PersistentStorage::readAnimationAt(std::uint32_t offset, std::uint8_t* out, std::size_t length) const {
    FileSource source("/neonbyte/animation.nbif"); return ready && source.readAt(offset,out,length);
}
const char* PersistentStorage::stagedPath() const {
    return kind_ == AssetKind::cover ? "/neonbyte/cover.part" : kind_ == AssetKind::animation ? "/neonbyte/animation.part" : "/neonbyte/firmware.part";
}
const char* PersistentStorage::installedPath() const {
    return kind_ == AssetKind::cover ? "/neonbyte/cover.nbic" : kind_ == AssetKind::animation ? "/neonbyte/animation.nbif" : "/neonbyte/firmware.bin";
}
bool PersistentStorage::selectAsset(AssetKind kind, std::string_view trackId) {
    kind_ = kind; coverTrack_ = {};
    return kind != AssetKind::cover || decodeTrackId(trackId,coverTrack_);
}
bool PersistentStorage::begin(std::uint32_t length) {
    const auto overhead = kind_ == AssetKind::cover ? COVER_TRACK_BYTES : 0;
    if (!ready || freeBytes() < std::uint64_t(length)+overhead+SPACE_RESERVE) return false;
    staged_ = LittleFS.open(stagedPath(),"w"); if (!staged_) return false;
    if (kind_ == AssetKind::cover) {
        const std::uint8_t lengthBytes[] = {std::uint8_t(coverTrack_.length),std::uint8_t(coverTrack_.length>>8)};
        if (staged_.write(lengthBytes,2) != 2 || staged_.write(reinterpret_cast<const std::uint8_t*>(coverTrack_.bytes.data()),coverTrack_.bytes.size()) != coverTrack_.bytes.size()) { abort(); return false; }
    }
    return true;
}
bool PersistentStorage::write(const std::uint8_t* data, std::size_t length) {
    return staged_ && staged_.write(data,length) == length;
}
bool PersistentStorage::commit() {
    if (staged_) return false; // A closed candidate must pass readback validation first.
    if (!LittleFS.rename(stagedPath(),installedPath())) return false;
    ++assetRevision; return true;
}
void PersistentStorage::abort() { staged_.close(); if (ready) LittleFS.remove(stagedPath()); }
void PersistentStorage::sealStaged() { staged_.flush(); staged_.close(); }
bool PersistentStorage::validateStaged() const {
    FileSource source(stagedPath());
    if (kind_ == AssetKind::firmware) return validateEsp8266Image(source) && validateArduinoImageCrc(source);
    if (kind_ == AssetKind::animation) {
        AnimationFile storage(source); AnimationReader reader(storage); AnimationMetadata metadata;
        return reader.open(metadata);
    }
    std::uint8_t header[9]{};
    const std::uint8_t expected[] = {'N','B','I','C',1,240,0,240,0};
    return source.size() == COVER_TRACK_BYTES+COVER_BYTES && source.readAt(COVER_TRACK_BYTES,header,sizeof(header)) && memcmp(header,expected,sizeof(header)) == 0;
}
bool PersistentStorage::readCover(std::string_view trackId, std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const {
    if (!ready || trackId.empty() || trackId.size() > MAX_TEXT_UTF8_BYTES || offset > 115200 || length > 115200-offset) return false;
    FileSource source("/neonbyte/cover.nbic"); std::uint8_t storedLength[2];
    if (source.size() != COVER_TRACK_BYTES+COVER_BYTES || !source.readAt(0,storedLength,2) || std::size_t(storedLength[0] | (storedLength[1]<<8)) != trackId.size()) return false;
    // Compare in small chunks rather than allocating another full UTF-8 field.
    std::uint8_t chunk[64];
    for (std::size_t position=0;position<trackId.size();position+=sizeof(chunk)) {
        const auto count = std::min(sizeof(chunk),trackId.size()-position);
        if (!source.readAt(2+position,chunk,count) || memcmp(chunk,trackId.data()+position,count)) return false;
    }
    return source.readAt(COVER_TRACK_BYTES+9+offset,bytes,length);
}
bool PersistentStorage::applyFirmware() {
#if NEONBYTE_ENABLE_OTA
    FileSource source("/neonbyte/firmware.bin");
    if (!ready || !ESP.checkFlashConfig(false) || ESP.getFlashChipRealSize() != 4*1024*1024 || !validateEsp8266Image(source) || !validateArduinoImageCrc(source)) return false;
    const auto freeSketch = ESP.getFreeSketchSpace();
    const auto available = freeSketch > 4096 ? (freeSketch-4096)&0xfffff000 : 0;
    if (source.size() > available || !Update.begin(source.size(),U_FLASH)) return false;
    std::uint8_t chunk[512];
    for (std::uint32_t offset=0;offset<source.size();) {
        const auto count = std::min<std::uint32_t>(sizeof(chunk),source.size()-offset);
        if (!source.readAt(offset,chunk,count) || Update.write(chunk,count) != count) { Update.end(false); return false; }
        offset += count; yield();
    }
    return Update.end(false);
#else
    return false;
#endif
}
} // namespace neonbyte
#endif
