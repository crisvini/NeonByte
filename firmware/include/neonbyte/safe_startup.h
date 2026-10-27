#pragma once
#include "neonbyte/protocol.h"
#include "neonbyte/wifi_configuration.h"
namespace neonbyte {
// Views must refer to immutable, program-lifetime private input.
struct RecoveryIdentity { std::string_view token, apPassword; };
enum class StartupResult { ok, unauthorized, invalid, conflict, storageUnavailable, applicationUnavailable };
class StartupServices {
public:
    virtual ~StartupServices() = default;
    virtual bool startRecoveryAp(RecoveryIdentity identity) = 0;
    virtual bool startHttp() = 0;
    virtual bool mountStorage() = 0;
    virtual bool loadWifi(WifiCredentials& credentials) = 0;
    virtual bool saveWifi(const WifiCredentials& credentials) = 0;
    virtual void connectStation(const WifiCredentials& credentials) = 0;
    virtual bool stationConnected(const WifiCredentials& credentials) const = 0;
    virtual bool setStartupGuard(bool risky) = 0;
    virtual bool startApplication() = 0;
    virtual void stopApplication() = 0;
};
class SafeStartup {
public:
    SafeStartup(StartupServices& services, RecoveryIdentity identity) : services_(services), identity_(identity), recoveryAuth_(identity.token) {}
    void begin(std::uint64_t now, bool previousFailure, bool maintenanceOnBoot = false);
    void tick(std::uint64_t now);
    bool authorized(std::string_view authorization) const;
    StartupResult stageWifi(std::string_view authorization, std::string_view form, bool temporary, std::uint64_t now);
    StartupResult confirmWifi(std::string_view authorization);
    StartupResult pauseApplication(std::string_view authorization);
    StartupResult prepareStorage(std::string_view authorization);
    StartupResult runApplication(std::string_view authorization);
    bool identityValid() const { return identityValid_; }
    bool recoveryApRunning() const { return apRunning_; }
    bool storageAvailable() const { return storageAvailable_; }
    bool configurationLoaded() const { return configurationLoaded_; }
    bool applicationRunning() const { return applicationRunning_; }
    bool applicationPaused() const { return !applicationRunning_ && !automaticStart_; }
    bool pendingWifi() const { return pendingWifi_; }
    bool volatileWifi() const { return volatileWifi_; }
    bool stationConnected() const;
    // Existing authenticated v1 configuration route retains its persistence semantics.
    void usePersistedWifi(const WifiCredentials& credentials, std::uint64_t now);
private:
    bool initializeStorage();
    bool initializeApplication();
    void connect(std::uint64_t now);
    StartupServices& services_;
    RecoveryIdentity identity_;
    BearerTokenAuthenticator recoveryAuth_;
    WifiCredentials activeWifi_{}, candidateWifi_{};
    std::uint64_t initializeAt_ = 0, retryApAt_ = 0, retryHttpAt_ = 0, retryStationAt_ = 0;
    bool identityValid_ = false, apRunning_ = false, httpRunning_ = false, automaticStart_ = false;
    bool storageAttempted_ = false, storageAvailable_ = false, configurationLoaded_ = false;
    bool applicationRunning_ = false, pendingWifi_ = false, candidateTemporary_ = false, volatileWifi_ = false;
};
// Returns an extension response; firmware uploads remain in the target adapter.
void handleMaintenance(const HttpRequest& request, SafeStartup& startup, std::uint64_t now, HttpResponse& response);
} // namespace neonbyte
