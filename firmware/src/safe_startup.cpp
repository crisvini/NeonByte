#include "neonbyte/safe_startup.h"
#include <cstdio>
namespace neonbyte {
namespace {
bool validSecret(std::string_view value, std::size_t length) {
    if (value.size() != length) return false;
    bool varied = false;
    for (char c : value) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        varied = varied || c != value.front();
    }
    return varied;
}
}
void SafeStartup::begin(std::uint64_t now, bool previousFailure, bool maintenanceOnBoot) {
    identityValid_ = validSecret(identity_.token,64) && validSecret(identity_.apPassword,32)
        && identity_.token.find(identity_.apPassword) == std::string_view::npos;
    if (!identityValid_) return;
    apRunning_ = services_.startRecoveryAp(identity_);
    httpRunning_ = services_.startHttp();
    retryApAt_ = retryHttpAt_ = now+5000; initializeAt_ = now+10000;
    automaticStart_ = !previousFailure && !maintenanceOnBoot;
    configurationLoadPending_ = !previousFailure && maintenanceOnBoot;
}
bool SafeStartup::authorized(std::string_view authorization) const {
    return identityValid_ && recoveryAuth_.isAuthorized(authorization);
}
bool SafeStartup::initializeConfigurationOnly() {
    if (configurationLoadAttempted_) return storageAvailable_;
    configurationLoadAttempted_ = true;
    // A reset while mounting/loading must bypass both on the next boot.
    if (!services_.setStartupGuard(true)) return false;
    storageAvailable_ = services_.mountConfigurationStorage();
    if (storageAvailable_) {
        WifiCredentials saved{};
        configurationLoaded_ = services_.loadWifi(saved) && isValidWifiConfiguration(saved);
        if (configurationLoaded_ && !pendingWifi_ && !volatileWifi_) activeWifi_ = saved;
    }
    if (!services_.setStartupGuard(false)) {
        storageAvailable_ = false; configurationLoaded_ = false; activeWifi_ = {};
        return false;
    }
    return storageAvailable_;
}
bool SafeStartup::initializeStorage() {
    if (storagePrepared_ && storageAvailable_) return true;
    // A reset while mounting/loading must bypass both on the next boot.
    if (!services_.setStartupGuard(true)) return false;
    storageAvailable_ = services_.mountStorage();
    if (storageAvailable_) {
        storagePrepared_ = true;
        if (!configurationLoaded_) {
            WifiCredentials saved{};
            configurationLoaded_ = services_.loadWifi(saved) && isValidWifiConfiguration(saved);
            if (configurationLoaded_ && !pendingWifi_ && !volatileWifi_) activeWifi_ = saved;
        }
    }
    if (!services_.setStartupGuard(false)) { storageAvailable_ = false; return false; }
    return storageAvailable_;
}
bool SafeStartup::initializeApplication() {
    if (applicationRunning_) return true;
    if (!services_.setStartupGuard(true)) return false;
    const bool started = services_.startApplication();
    const bool cleared = services_.setStartupGuard(false);
    applicationRunning_ = started && cleared;
    if (!applicationRunning_) services_.stopApplication();
    return applicationRunning_;
}
void SafeStartup::connect(std::uint64_t now) {
    const auto& target = pendingWifi_ ? candidateWifi_ : activeWifi_;
    if (isValidWifiConfiguration(target)) services_.connectStation(target);
    retryStationAt_ = now+30000;
}
bool SafeStartup::stationConnected() const {
    return services_.stationConnected(pendingWifi_ ? candidateWifi_ : activeWifi_);
}
void SafeStartup::tick(std::uint64_t now) {
    if (!identityValid_) return;
    if (!apRunning_ && now >= retryApAt_) {
        apRunning_ = services_.startRecoveryAp(identity_); retryApAt_ = now+5000;
        if (apRunning_) initializeAt_ = now+10000;
    }
    if (!httpRunning_ && now >= retryHttpAt_) {
        httpRunning_ = services_.startHttp(); retryHttpAt_ = now+5000;
        if (httpRunning_) initializeAt_ = now+10000;
    }
    if (automaticStart_ && apRunning_ && httpRunning_ && now >= initializeAt_
        && services_.backgroundStartupWorkAllowed()) {
        automaticStart_ = false;
        if (initializeStorage() && configurationLoaded_) initializeApplication();
    } else if (configurationLoadPending_ && apRunning_ && httpRunning_ && now >= initializeAt_
        && services_.backgroundStartupWorkAllowed()) {
        configurationLoadPending_ = false;
        if (initializeConfigurationOnly() && configurationLoaded_ && !pendingWifi_ && !volatileWifi_) connect(now);
    }
    if (!services_.backgroundStartupWorkAllowed()) return;
    const auto& target = pendingWifi_ ? candidateWifi_ : activeWifi_;
    if (isValidWifiConfiguration(target) && !stationConnected() && now >= retryStationAt_) connect(now);
}
StartupResult SafeStartup::stageWifi(std::string_view auth, std::string_view form, bool temporary, std::uint64_t now) {
    if (!authorized(auth)) return StartupResult::unauthorized;
    WifiCredentials candidate;
    if (!parseWifiConfiguration(form,candidate)) return StartupResult::invalid;
    candidateWifi_ = candidate; pendingWifi_ = true; candidateTemporary_ = temporary;
    configurationLoadPending_ = false; configurationLoadAttempted_ = true;
    // Never initialize display/storage automatically during provisioning.
    automaticStart_ = false;
    connect(now); return StartupResult::ok;
}
StartupResult SafeStartup::confirmWifi(std::string_view auth) {
    if (!authorized(auth)) return StartupResult::unauthorized;
    if (!pendingWifi_ || !services_.stationConnected(candidateWifi_)) return StartupResult::conflict;
    if (!candidateTemporary_) {
        if (prepareStorage(auth) != StartupResult::ok || !services_.saveWifi(candidateWifi_)) return StartupResult::storageUnavailable;
        configurationLoaded_ = true;
    }
    activeWifi_ = candidateWifi_; candidateWifi_ = {};
    volatileWifi_ = candidateTemporary_; pendingWifi_ = false;
    return StartupResult::ok;
}
StartupResult SafeStartup::pauseApplication(std::string_view auth) {
    if (!authorized(auth)) return StartupResult::unauthorized;
    automaticStart_ = false; applicationRunning_ = false; services_.stopApplication();
    return StartupResult::ok;
}
StartupResult SafeStartup::prepareStorage(std::string_view auth) {
    if (!authorized(auth)) return StartupResult::unauthorized;
    automaticStart_ = false; configurationLoadPending_ = false; configurationLoadAttempted_ = true;
    return initializeStorage() ? StartupResult::ok : StartupResult::storageUnavailable;
}
StartupResult SafeStartup::runApplication(std::string_view auth) {
    if (!authorized(auth)) return StartupResult::unauthorized;
    automaticStart_ = false;
    if (prepareStorage(auth) != StartupResult::ok) return StartupResult::storageUnavailable;
    if (!configurationLoaded_) return StartupResult::conflict;
    return initializeApplication() ? StartupResult::ok : StartupResult::applicationUnavailable;
}
void SafeStartup::usePersistedWifi(const WifiCredentials& credentials, std::uint64_t now) {
    activeWifi_ = credentials; candidateWifi_ = {}; pendingWifi_ = volatileWifi_ = false;
    configurationLoaded_ = true; storageAvailable_ = storagePrepared_ = true;
    configurationLoadPending_ = false; configurationLoadAttempted_ = true; connect(now);
}
void handleMaintenance(const HttpRequest& request, SafeStartup& startup, std::uint64_t now, HttpResponse& response) {
    response = {}; response.contentType = "application/json";
    auto error = [&](unsigned status, const char* code, const char* message) {
        response.statusCode = status;
        response.bodySize = snprintf(response.body.data(),response.body.size(),"{\"code\":\"%s\",\"message\":\"%s\"}",code,message);
    };
    if (!startup.authorized(request.authorization)) { error(401,"unauthorized","A valid recovery bearer token is required."); return; }
    if (request.path == "/maintenance/v1/status" && request.method == HttpMethod::get && request.body.empty()) {
        response.statusCode = 200;
        response.bodySize = snprintf(response.body.data(),response.body.size(),
            "{\"storageAvailable\":%s,\"configurationLoaded\":%s,\"applicationRunning\":%s,\"recoveryApRunning\":%s,\"stationConnected\":%s,\"pendingWifi\":%s,\"volatileWifi\":%s}",
            startup.storageAvailable() ? "true" : "false",startup.configurationLoaded() ? "true" : "false",
            startup.applicationRunning() ? "true" : "false",startup.recoveryApRunning() ? "true" : "false",
            startup.stationConnected() ? "true" : "false",startup.pendingWifi() ? "true" : "false",startup.volatileWifi() ? "true" : "false");
        return;
    }
    StartupResult result;
    const bool wifi = request.path == "/maintenance/v1/wifi" || request.path == "/maintenance/v1/wifi/temporary";
    if (wifi) {
        if (request.method != HttpMethod::put || request.contentType != "application/x-www-form-urlencoded" || request.body.size() > 512) {
            error(400,"invalid_request","Use PUT with a Wi-Fi form of at most 512 bytes."); return;
        }
        result = startup.stageWifi(request.authorization,request.body,request.path == "/maintenance/v1/wifi/temporary",now);
    } else {
        if (request.method != HttpMethod::post || !request.body.empty()) { error(400,"invalid_request","Use POST with an empty body."); return; }
        if (request.path == "/maintenance/v1/wifi/confirm") result = startup.confirmWifi(request.authorization);
        else if (request.path == "/maintenance/v1/storage") result = startup.prepareStorage(request.authorization);
        else if (request.path == "/maintenance/v1/run") result = startup.runApplication(request.authorization);
        else if (request.path == "/maintenance/v1/pause") result = startup.pauseApplication(request.authorization);
        else { error(404,"not_found","The maintenance route does not exist."); return; }
    }
    switch (result) {
        case StartupResult::ok: response.statusCode = 204; response.bodySize = 0; return;
        case StartupResult::unauthorized: error(401,"unauthorized","A valid recovery bearer token is required."); return;
        case StartupResult::invalid: error(400,"invalid_request","Provide a valid ssid and password form."); return;
        case StartupResult::conflict: error(409,"conflict","Confirm the candidate Wi-Fi connection and persistent configuration first."); return;
        case StartupResult::storageUnavailable: error(409,"conflict","Storage is unavailable; retain the previous settings or explicitly choose temporary Wi-Fi."); return;
        case StartupResult::applicationUnavailable: error(500,"internal_error","Application startup failed; maintenance remains available."); return;
    }
}
} // namespace neonbyte
