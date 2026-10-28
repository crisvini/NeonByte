#pragma once
#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/animation_reader.h"
#include "neonbyte/firmware_image.h"
#include "neonbyte/storage_mount.h"
#include "neonbyte/transfer.h"
#include <LittleFS.h>
namespace neonbyte {
constexpr std::uint32_t COVER_TRACK_BYTES = 1026;
enum class AssetKind { cover, animation, firmware };
struct DeviceConfiguration {
    std::uint32_t version = 1;
    char ssid[33]{};
    char password[65]{};
    char token[65]{};
    char apPassword[17]{};
};
class FileSource final : public ImageSource {
public:
    explicit FileSource(const char* path) : file_(LittleFS.open(path,"r")) {}
    std::uint32_t size() const override { return file_ ? file_.size() : 0; }
    bool readAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override;
private:
    mutable File file_;
};
class PersistentStorage final : public Storage, public TransferSink {
public:
    bool mountForConfiguration();
    bool beginStorage();
    bool loadConfiguration();
    bool saveConfiguration(const DeviceConfiguration& value);
    bool loadMode(DisplayMode& mode) const override;
    bool saveMode(DisplayMode mode) override;
    std::uint64_t freeBytes() const override;
    std::uint32_t animationSize() const override;
    bool readAnimationAt(std::uint32_t offset, std::uint8_t* destination, std::size_t length) const override;
    bool selectAsset(AssetKind kind, std::string_view trackId);
    bool begin(std::uint32_t length) override;
    bool write(const std::uint8_t* data, std::size_t length) override;
    bool commit() override;
    void abort() override;
    void sealStaged();
    bool validateStaged() const;
    bool applyFirmware();
    bool readCover(std::string_view trackId, std::uint32_t offset, std::uint8_t* bytes, std::size_t length) const;
    DeviceConfiguration configuration{};
    std::uint32_t assetRevision = 0;
    bool ready = false;
private:
    StorageMountState mountState_{};
    const char* stagedPath() const;
    const char* installedPath() const;
    AssetKind kind_ = AssetKind::animation;
    FixedText coverTrack_{};
    File staged_;
};
} // namespace neonbyte
#endif
