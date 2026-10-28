#ifdef ARDUINO_ARCH_ESP8266
#include "neonbyte/esp8266/http_server.h"
#include "neonbyte/maintenance_info.h"
#include "neonbyte/wifi_configuration.h"
#include <bearssl/bearssl_hash.h>
#include <pgmspace.h>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <new>
namespace neonbyte {
namespace {
bool parseUploadPath(std::string_view path, std::uint32_t& uploadId, std::string_view& tail) {
    constexpr std::string_view PREFIX = "/api/v2/animation/uploads/";
    if (path.substr(0,PREFIX.size()) != PREFIX || path.size() < PREFIX.size()+8) return false;
    std::uint32_t value = 0;
    for (std::size_t index=0; index<8; ++index) {
        const char c = path[PREFIX.size()+index];
        const std::uint8_t digit = c >= '0' && c <= '9' ? c-'0' : c >= 'a' && c <= 'f' ? c-'a'+10 : 0xff;
        if (digit == 0xff) return false;
        value = (value << 4) | digit;
    }
    const auto suffix = path.substr(PREFIX.size()+8);
    if (!suffix.empty() && suffix.front() != '/') return false;
    uploadId = value;
    tail = suffix;
    return uploadId != 0;
}
bool parseOffset(std::string_view query, std::uint32_t& offset) {
    if (query.size() < 8 || query.substr(0,7) != "offset=") return false;
    std::uint32_t value = 0;
    for (char c : query.substr(7)) {
        if (c < '0' || c > '9' || value > (0xffffffffu - static_cast<std::uint32_t>(c-'0'))/10) return false;
        value = value*10 + static_cast<std::uint32_t>(c-'0');
    }
    offset = value;
    return true;
}
void skipWhitespace(std::string_view input, std::size_t& offset) {
    while (offset<input.size() && (input[offset]==' ' || input[offset]=='\t' || input[offset]=='\r' || input[offset]=='\n')) ++offset;
}
bool parseJsonString(std::string_view input, std::size_t& offset, std::string_view& value) {
    skipWhitespace(input,offset);
    if (offset>=input.size() || input[offset++]!='"') return false;
    const auto start=offset;
    while (offset<input.size() && input[offset]!='"') {
        const auto c=static_cast<unsigned char>(input[offset]);
        if (c<0x20 || c=='\\') return false;
        ++offset;
    }
    if (offset>=input.size()) return false;
    value=input.substr(start,offset-start); ++offset;
    return true;
}
bool parseJsonSize(std::string_view input, std::size_t& offset, std::uint32_t& value) {
    skipWhitespace(input,offset);
    const auto start=offset;
    if (offset<input.size() && input[offset]=='0') ++offset;
    else while (offset<input.size() && input[offset]>='0' && input[offset]<='9') ++offset;
    if (offset==start || (input[start]=='0' && offset-start>1)) return false;
    std::uint32_t parsed=0;
    for (char c:input.substr(start,offset-start)) {
        const auto digit=static_cast<std::uint32_t>(c-'0');
        if (parsed>(0xffffffffu-digit)/10) return false;
        parsed=parsed*10+digit;
    }
    value=parsed;
    return true;
}
bool parseAnimationBegin(std::string_view input, std::uint32_t& sizeBytes, std::string_view& hash) {
    std::size_t offset=0;
    skipWhitespace(input,offset);
    if (offset>=input.size() || input[offset++]!='{') return false;
    bool hasSize=false, hasHash=false;
    for (unsigned member=0;member<2;++member) {
        std::string_view key;
        if (!parseJsonString(input,offset,key)) return false;
        skipWhitespace(input,offset);
        if (offset>=input.size() || input[offset++]!=':') return false;
        if (key=="sizeBytes" && !hasSize) {
            hasSize=parseJsonSize(input,offset,sizeBytes);
            if (!hasSize) return false;
        } else if (key=="sha256" && !hasHash) {
            hasHash=parseJsonString(input,offset,hash) && isSha256(hash);
            if (!hasHash) return false;
        } else return false;
        skipWhitespace(input,offset);
        if (member==0) {
            if (offset>=input.size() || input[offset++]!=',') return false;
        }
    }
    skipWhitespace(input,offset);
    return hasSize && hasHash && offset<input.size() && input[offset++] == '}' &&
        (skipWhitespace(input,offset), offset==input.size());
}
const char* animationUploadStateName(AnimationUploadState state) {
    switch (state) {
        case AnimationUploadState::Receiving: return "receiving";
        case AnimationUploadState::Verifying: return "verifying";
        case AnimationUploadState::Ready: return "ready";
        case AnimationUploadState::Installed: return "installed";
        case AnimationUploadState::Failed: return "failed";
        case AnimationUploadState::Cancelled: return "cancelled";
        case AnimationUploadState::Idle: return "none";
    }
    return "failed";
}
const char* animationUploadErrorName(AnimationUploadError error) {
    switch (error) {
        case AnimationUploadError::None: return "";
        case AnimationUploadError::InvalidRequest: return "invalid_request";
        case AnimationUploadError::InsufficientStorage: return "insufficient_storage";
        case AnimationUploadError::WriteFailed: return "write_failed";
        case AnimationUploadError::ReadFailed: return "read_failed";
        case AnimationUploadError::ChecksumMismatch: return "checksum_mismatch";
        case AnimationUploadError::InvalidAnimation: return "invalid_animation";
        case AnimationUploadError::PromotionFailed: return "promotion_failed";
        case AnimationUploadError::Expired: return "expired";
    }
    return "invalid_animation";
}
} // namespace
void Sha256Digest::finish(char* hex64) {
    std::uint8_t bytes[32]; constexpr char HEX_DIGITS[] = "0123456789abcdef";
    br_sha256_out(&context_,bytes);
    for (unsigned i=0;i<32;++i) { hex64[2*i] = HEX_DIGITS[bytes[i]>>4]; hex64[2*i+1] = HEX_DIGITS[bytes[i]&15]; }
}
void DeviceHttpServer::close() {
    if (legacyAnimationPromotionPending_) {
        storage_.discardAnimationCandidate();
        legacyAnimationPromotionPending_ = false;
    }
    if (uploadActive_) {
        ++diagnostics_.uploadsAborted; uploadActive_ = false;
        hashJob_.reset(); fileHashSource_.reset(); hashSource_ = nullptr; activeTransfer_->abort();
    }
    const bool keepQueuedChunk = animationChunkWriting_ && animationUpload_.hasPendingChunk();
    if (!keepQueuedChunk) animationChunkBody_.reset();
    else animationChunkDetached_ = true;
    client_.stop(); body_.reset();
    headerSize_ = received_ = sent_ = 0;
    activeTransfer_ = &transfer_;
    activeRawOta_ = &maintenanceOta_;
    headers_ = {}; response_ = {}; responseHeaderSize_ = 0;
    started_ = lastActivity_ = 0; requestDeadlineMs_ = 60000; clientActive_ = false;
    finalizing_ = readingBody_ = sending_ = binary_ = firmware_ = maintenanceFirmware_ = stockRestore_ = maintenance_ = false;
    animationV2Route_ = false; animationV2Request_ = AnimationV2Request::none;
    if (!keepQueuedChunk) { animationChunkWriting_ = animationChunkDetached_ = false; }
}
void DeviceHttpServer::error(unsigned status, const char* code, const char* message) {
    if (uploadActive_) {
        ++diagnostics_.uploadsAborted; ++diagnostics_.uploadFailures; uploadActive_ = false;
        hashJob_.reset(); fileHashSource_.reset(); hashSource_ = nullptr; activeTransfer_->abort();
    }
    finalizing_ = false; response_ = {}; response_.statusCode = status;
    response_.contentType = "application/json";
    const int prefix = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"code\":\"%s\",\"message\":\""),code);
    if (prefix < 0 || static_cast<std::size_t>(prefix) >= response_.body.size() - 3) {
        response_.bodySize = 0;
        prepareResponse();
        return;
    }
    std::size_t position = static_cast<std::size_t>(prefix);
    while (position + 3 < response_.body.size()) {
        const auto character = static_cast<char>(pgm_read_byte(message++));
        if (character == '\0') break;
        response_.body[position++] = character;
    }
    response_.body[position++] = '"';
    response_.body[position++] = '}';
    response_.body[position] = '\0';
    response_.bodySize = position;
    prepareResponse();
}
void DeviceHttpServer::prepareResponse() {
    const auto type = response_.contentType.empty() ? std::string_view("application/json") : response_.contentType;
    responseHeaderSize_ = snprintf_P(responseHeaders_.data(),responseHeaders_.size(),PSTR("HTTP/1.1 %u %s\r\nContent-Length: %u\r\nContent-Type: %.*s\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"),
        response_.statusCode,response_.statusCode < 300 ? "OK" : "Error",unsigned(response_.bodySize),int(type.size()),type.data());
    sending_ = true; sent_ = 0; body_.reset();
}
void DeviceHttpServer::headersComplete() {
    if (!headers_.parse({headerBytes_.data(),headerSize_})) { error(400,"invalid_request",PSTR("Use unambiguous HTTP/1.1 framing and Content-Length.")); return; }
    animationV2Route_ = headers_.path.size() >= 8 && headers_.path.substr(0,8) == "/api/v2/";
    maintenance_ = headers_.path.substr(0,16) == "/maintenance/v1/";
    stockRestore_ = isStockRestorePath(headers_.path);
    maintenanceFirmware_ = isRawMaintenanceUploadPath(headers_.path);
    firmware_ = headers_.path == "/api/v1/firmware" || maintenanceFirmware_;
    if (maintenanceFirmware_) {
        const bool identityReady = startup_.identityValid() && !buildId_.empty() && !profile_.empty() &&
            recoveryIdentityFingerprint_.size() == 64;
        const bool runtimeReady = ESP.getFlashChipRealSize() == OTA_FLASH_BYTES && ESP.checkFlashConfig(false);
        const bool otaEnabled = NEONBYTE_ENABLE_OTA != 0 && identityReady && runtimeReady;
        const auto admission = stockRestore_
            ? stockRestoreAdmission(startup_.authorized(headers_.authorization),startup_.applicationPaused(),
                otaEnabled,NEONBYTE_ENABLE_STOCK_RESTORE != 0,
                headers_.method,headers_.contentType,headers_.contentLength,headers_.sha256)
            : maintenanceOtaAdmission(startup_.authorized(headers_.authorization),startup_.applicationPaused(),
                otaEnabled,headers_.method,headers_.contentType,headers_.contentLength,headers_.sha256);
        switch (admission) {
            case OtaAdmissionError::none: break;
            case OtaAdmissionError::unauthorized: error(401,"unauthorized",PSTR("A valid recovery bearer token is required.")); return;
            case OtaAdmissionError::applicationRunning: error(409,"conflict",PSTR("Pause the application before a maintenance firmware upload.")); return;
            case OtaAdmissionError::disabled: error(409,"conflict",PSTR("The requested update operation is disabled pending installation and recovery validation.")); return;
            case OtaAdmissionError::method: error(400,"invalid_request",PSTR("The upload route requires PUT.")); return;
            case OtaAdmissionError::mediaType: error(415,"unsupported_media_type",PSTR("Upload application/octet-stream.")); return;
            case OtaAdmissionError::tooLarge: error(413,"payload_too_large",PSTR("The asset exceeds this build's upload limit.")); return;
            case OtaAdmissionError::invalidBody: error(400,"invalid_request",PSTR("Provide the supported image length and lowercase SHA-256.")); return;
        }
    } else if (maintenance_ ? !startup_.authorized(headers_.authorization)
        : headers_.path != "/api/v1/status" && !authenticator_.isAuthorized(headers_.authorization)) {
        error(401,"unauthorized",PSTR("A valid bearer token is required.")); return;
    }
    if (!maintenance_ && !protocol_) { error(409,"conflict",PSTR("The application is paused; use authenticated maintenance.")); return; }
    if (animationV2Route_) {
        if (headers_.path == "/api/v2/media-capabilities" && headers_.method == HttpMethod::get &&
            headers_.contentLength == 0 && headers_.query.empty()) {
            animationV2Request_ = AnimationV2Request::capabilities;
        } else if (headers_.path == "/api/v2/animation/uploads" && headers_.method == HttpMethod::post &&
                   headers_.contentType == "application/json" && headers_.query.empty() && headers_.contentLength > 0 &&
                   headers_.contentLength < controlBody_.size()) {
            animationV2Request_ = AnimationV2Request::begin;
        } else if (headers_.method == HttpMethod::put && headers_.contentType == "application/octet-stream" &&
                   headers_.contentLength > 0 && headers_.contentLength <= ANIMATION_UPLOAD_MAX_CHUNK_BYTES) {
            std::string_view tail;
            if (parseUploadPath(headers_.path,animationUploadId_,tail) && tail == "/chunks" &&
                parseOffset(headers_.query,animationChunkOffset_)) {
                animationV2Request_ = AnimationV2Request::chunk;
                animationChunkBody_.reset(new (std::nothrow) std::uint8_t[headers_.contentLength]);
                if (!animationChunkBody_) { error(500,"internal_error",PSTR("Insufficient memory for this upload chunk.")); return; }
            }
        } else if (headers_.contentLength == 0 && headers_.query.empty()) {
            std::string_view tail;
            if (parseUploadPath(headers_.path,animationUploadId_,tail)) {
                if (headers_.method == HttpMethod::get && tail.empty()) animationV2Request_ = AnimationV2Request::status;
                else if (headers_.method == HttpMethod::deleteMethod && tail.empty()) animationV2Request_ = AnimationV2Request::cancel;
                else if (headers_.method == HttpMethod::post && tail == "/complete") animationV2Request_ = AnimationV2Request::complete;
            }
        }
        if (animationV2Request_ == AnimationV2Request::none) {
            animationV2Request_ = AnimationV2Request::invalid;
            error(400,"invalid_request",PSTR("The animation upload request does not match the supported route.")); return;
        }
        if (animationV2Request_ == AnimationV2Request::chunk) {
            readingBody_ = true;
            return;
        }
        readingBody_ = true;
        if (headers_.contentLength == 0) bodyComplete();
        return;
    }
    if (!headers_.query.empty()) { error(400,"invalid_request",PSTR("Query parameters are supported only on animation chunk uploads.")); return; }
    binary_ = firmware_ || headers_.path == "/api/v1/cover" || headers_.path == "/api/v1/animation";
    if (binary_) {
        if (headers_.method != HttpMethod::put) { error(400,"invalid_request",PSTR("The upload route requires PUT.")); return; }
        if (firmware_ && !maintenanceFirmware_ && !NEONBYTE_ENABLE_OTA) { error(409,"conflict",PSTR("OTA is disabled pending installation and recovery validation.")); return; }
        if (headers_.contentType != "application/octet-stream") { error(415,"unsupported_media_type",PSTR("Upload application/octet-stream.")); return; }
        const auto kind = firmware_ ? AssetKind::firmware : headers_.path == "/api/v1/cover" ? AssetKind::cover : AssetKind::animation;
        const auto limit = firmware_ ? FIRMWARE_BYTES_LIMIT : kind == AssetKind::cover ? COVER_BYTES : ANIMATION_BYTES_LIMIT;
        if (headers_.contentLength > limit) { error(413,"payload_too_large",PSTR("The asset exceeds this build's upload limit.")); return; }
        if (!headers_.contentLength || !isSha256(headers_.sha256)) { error(400,"invalid_request",PSTR("Provide a nonzero length and lowercase SHA-256.")); return; }
        if (!firmware_ && animationUpload_.blocksOtherUploads()) { error(409,"conflict",PSTR("An animation upload session owns media storage.")); return; }
        if (!firmware_) requestDeadlineMs_ = 60000 + ((std::uint64_t(headers_.contentLength)+8191)/8192)*1000;
        if (kind == AssetKind::cover && headers_.contentLength != COVER_BYTES) { error(422,"invalid_content",PSTR("The cover must be NBIC v1 at 240 by 240.")); return; }
        if (!prepareUploadStorage(headers_.path,[&] { return storage_.selectAsset(kind,headers_.trackId); })) { error(400,"invalid_request",PSTR("Provide a percent-encoded UTF-8 X-Track-Id of 1 to 256 code points.")); return; }
        activeRawOta_ = stockRestore_ ? &stockRestoreOta_ : &maintenanceOta_;
        activeTransfer_ = &selectUploadTransfer(headers_.path,transfer_,stockRestore_ ? stockRestoreTransfer_ : maintenanceTransfer_);
        if (maintenanceFirmware_ && !activeRawOta_->setExpectedHash(headers_.sha256)) { error(400,"invalid_request",PSTR("Provide a supported lowercase SHA-256 digest.")); return; }
        if (!activeTransfer_->begin(headers_.contentLength,limit,headers_.sha256)) {
            error(409,"conflict",maintenanceFirmware_ ? PSTR("Raw flash staging is unavailable for this runtime layout.") : PSTR("Storage is unavailable or insufficient for atomic replacement.")); return;
        }
        uploadActive_ = true; ++diagnostics_.uploadsStarted;
    } else {
        const auto limit = maintenance_ || headers_.path == "/api/v1/config" ? 512U : JSON_BODY_LIMIT;
        if (headers_.contentLength > limit) { error(413,"payload_too_large",PSTR("The request body exceeds the route limit.")); return; }
        if (limit == JSON_BODY_LIMIT) {
            body_.reset(new (std::nothrow) char[headers_.contentLength+1]);
            if (!body_) { error(500,"internal_error",PSTR("Insufficient memory for this request.")); return; }
        }
    }
    readingBody_ = true;
    if (!headers_.contentLength) bodyComplete();
}
void DeviceHttpServer::configureWifi() {
    if (headers_.method != HttpMethod::put || headers_.contentType != "application/x-www-form-urlencoded") { error(400,"invalid_request",PSTR("Use PUT with an ssid and password form.")); return; }
    WifiCredentials credentials;
    if (!parseWifiConfiguration({bodyData(),received_},credentials)) { error(400,"invalid_request",PSTR("Provide a valid ssid and password form.")); return; }
    DeviceConfiguration candidate = storage_.configuration;
    memcpy(candidate.ssid,credentials.ssid,sizeof(candidate.ssid));
    memcpy(candidate.password,credentials.password,sizeof(candidate.password));
    if (!storage_.saveConfiguration(candidate)) { error(500,"internal_error",PSTR("The Wi-Fi configuration could not be saved.")); return; }
    startup_.usePersistedWifi(credentials,lastActivity_); response_ = {}; response_.statusCode = 204; prepareResponse();
}
void DeviceHttpServer::finishBinary() {
    if (legacyAnimationPromotionPending_) {
        if (storage_.animationPromotionFailed()) {
            storage_.discardAnimationCandidate();
            legacyAnimationPromotionPending_ = false;
            error(500,"internal_error",PSTR("The validated animation could not be installed safely.")); return;
        }
        if (storage_.animationRevision == legacyAnimationGeneration_) return;
        legacyAnimationPromotionPending_ = false;
        finalizing_ = false;
        if (uploadActive_) { ++diagnostics_.uploadsCompleted; uploadActive_ = false; }
        response_ = {}; response_.statusCode = 204; prepareResponse();
        return;
    }
    const auto result = hashJob_->step(chunk_.data(),chunk_.size());
    if (result == HashStep::pending) return;
    if (result == HashStep::failed) { error(500,"internal_error",PSTR("The staged asset could not be read.")); return; }
    if (maintenanceFirmware_ && !maintenanceOtaBodyHasNoExtraBytes(received_,headers_.contentLength,static_cast<std::size_t>(std::max(0,client_.available())))) {
        error(400,"invalid_request",PSTR("The firmware body must match Content-Length exactly.")); return;
    }
    char actualHash[64]; digest_.finish(actualHash);
    hashJob_.reset(); fileHashSource_.reset(); hashSource_ = nullptr; finalizing_ = false;
    if (!activeTransfer_->finish({actualHash,sizeof(actualHash)},true)) { error(422,"invalid_content",PSTR("Checksum validation or atomic installation failed.")); return; }
    if (!maintenanceFirmware_ && headers_.path == "/api/v1/animation") {
        legacyAnimationPromotionPending_ = true;
        legacyAnimationGeneration_ = storage_.animationRevision;
        finalizing_ = true;
        return;
    }
    if (firmware_) {
        if (!maintenanceFirmware_ && !storage_.applyFirmware()) { error(500,"internal_error",PSTR("Firmware staging was rejected; no restart was requested.")); return; }
        rebootPending_ = !maintenanceFirmware_ || maintenanceOtaRestartAllowed(activeRawOta_->state());
        if (!rebootPending_) { error(500,"internal_error",PSTR("Firmware staging was rejected; no restart was requested.")); return; }
    }
    if (uploadActive_) { ++diagnostics_.uploadsCompleted; uploadActive_ = false; }
    response_ = {}; response_.statusCode = 204; prepareResponse();
}
void DeviceHttpServer::dispatchJson() {
    bodyData()[received_] = 0;
    const HttpRequest request{headers_.method,headers_.path,headers_.authorization,headers_.contentType,{bodyData(),received_}};
    if (maintenance_ && request.path == "/maintenance/v1/info") {
        if (!startup_.authorized(request.authorization)) { error(401,"unauthorized",PSTR("A valid recovery bearer token is required.")); return; }
        if (request.method != HttpMethod::get || !request.body.empty()) { error(400,"invalid_request",PSTR("Use GET with an empty body.")); return; }
        char deviceId[32];
        snprintf_P(deviceId,sizeof(deviceId),PSTR("esp8266-%06lx"),static_cast<unsigned long>(ESP.getChipId()));
        const bool identityReady = startup_.identityValid() && !buildId_.empty() && !profile_.empty() &&
            recoveryIdentityFingerprint_.size() == 64;
        const bool runtimeReady = ESP.getFlashChipRealSize() == OTA_FLASH_BYTES && ESP.checkFlashConfig(false);
        const bool otaEnabled = NEONBYTE_ENABLE_OTA != 0 && identityReady && runtimeReady;
        const auto maxFirmwareBytes = maintenanceFirmwareCapacity(otaEnabled,ESP.getFreeSketchSpace(),FIRMWARE_BYTES_LIMIT);
        const IPAddress stationAddress = WiFi.status() == WL_CONNECTED ? WiFi.localIP() : IPAddress(0,0,0,0);
        const IPAddress apAddress = startup_.recoveryApRunning() ? WiFi.softAPIP() : IPAddress(0,0,0,0);
        char stationIp[16], apIp[16];
        snprintf_P(stationIp,sizeof(stationIp),PSTR("%u.%u.%u.%u"),stationAddress[0],stationAddress[1],stationAddress[2],stationAddress[3]);
        snprintf_P(apIp,sizeof(apIp),PSTR("%u.%u.%u.%u"),apAddress[0],apAddress[1],apAddress[2],apAddress[3]);
        const MaintenanceInfo info{deviceId,bootId_,buildId_,"0.1.0-phase4",stationIp,apIp,profile_,
            recoveryIdentityFingerprint_,maxFirmwareBytes,otaEnabled};
        response_ = {}; response_.statusCode = 200; response_.contentType = "application/json";
        if (!writeMaintenanceInfoJson(info,response_.body.data(),response_.body.size(),response_.bodySize)) {
            error(500,"internal_error",PSTR("Maintenance information is unavailable.")); return;
        }
        prepareResponse(); return;
    }
    if (maintenance_ && request.path == "/maintenance/v1/diagnostics") {
        if (!startup_.authorized(request.authorization)) { error(401,"unauthorized",PSTR("A valid recovery bearer token is required.")); return; }
        if (request.method != HttpMethod::get || !request.body.empty()) { error(400,"invalid_request",PSTR("Use GET with an empty body.")); return; }
        const auto* reset = ESP.getResetInfoPtr();
        response_ = {}; response_.statusCode = 200; response_.contentType = "application/json";
        const int written = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"freeHeapBytes\":%lu,\"maxFreeBlockBytes\":%lu,\"resetReason\":%lu,"
            "\"connectionsAccepted\":%lu,\"connectionsDisconnected\":%lu,\"idleTimeouts\":%lu,\"totalTimeouts\":%lu,"
            "\"uploadsStarted\":%lu,\"uploadsAborted\":%lu,\"uploadsCompleted\":%lu,\"uploadFailures\":%lu,"
            "\"uploadBytes\":%lu,\"maxLoopGapMs\":%lu}"),
            static_cast<unsigned long>(ESP.getFreeHeap()),static_cast<unsigned long>(ESP.getMaxFreeBlockSize()),
            static_cast<unsigned long>(reset ? reset->reason : 0xffffffffUL),
            static_cast<unsigned long>(diagnostics_.connectionsAccepted),static_cast<unsigned long>(diagnostics_.connectionsDisconnected),
            static_cast<unsigned long>(diagnostics_.idleTimeouts),static_cast<unsigned long>(diagnostics_.totalTimeouts),
            static_cast<unsigned long>(diagnostics_.uploadsStarted),static_cast<unsigned long>(diagnostics_.uploadsAborted),
            static_cast<unsigned long>(diagnostics_.uploadsCompleted),static_cast<unsigned long>(diagnostics_.uploadFailures),
            static_cast<unsigned long>(diagnostics_.uploadBytes),static_cast<unsigned long>(diagnostics_.maxLoopGapMs));
        if (written < 0 || static_cast<std::size_t>(written) >= response_.body.size()) { error(500,"internal_error",PSTR("Diagnostics are unavailable.")); return; }
        response_.bodySize = static_cast<std::size_t>(written); prepareResponse(); return;
    }
    if (maintenance_) { handleMaintenance(request,startup_,lastActivity_,response_); prepareResponse(); return; }
    if (headers_.path == "/api/v1/config") { configureWifi(); return; }
    const String ip = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    response_ = protocol_->handle(request,{"0.1.0-phase4",{ip.c_str(),ip.length()}}); prepareResponse();
}
void DeviceHttpServer::bodyComplete() {
    if (animationV2Route_ && animationV2Request_ == AnimationV2Request::chunk) {
        const auto queued = animationUpload_.queueChunk(animationUploadId_,animationChunkOffset_,
            animationChunkBody_.get(),received_,lastActivity_);
        if (queued != AnimationChunkResult::Pending) {
            if (queued == AnimationChunkResult::NotFound) error(404,"not_found",PSTR("The animation upload session was not found."));
            else if (queued == AnimationChunkResult::Conflict) error(409,"conflict",PSTR("The chunk offset or replay does not match the active upload."));
            else error(400,"invalid_request",PSTR("The animation upload chunk is invalid."));
            return;
        }
        animationChunkWriting_ = true;
        finalizing_ = true;
        return;
    }
    if (animationV2Route_) { dispatchAnimationV2(); return; }
    if (!binary_) { dispatchJson(); return; }
    std::uint32_t prefix = 0;
    if (maintenanceFirmware_) {
        hashSource_ = activeRawOta_;
    } else {
        storage_.sealStaged();
        if (!storage_.validateStaged()) { error(422,"invalid_content",PSTR("The uploaded asset format is invalid.")); return; }
        const char* path = firmware_ ? "/neonbyte/firmware.part" : headers_.path == "/api/v1/cover" ? "/neonbyte/cover.part" : "/neonbyte/animation.part";
        prefix = headers_.path == "/api/v1/cover" ? COVER_TRACK_BYTES : 0U;
        fileHashSource_.reset(new (std::nothrow) FileSource(path));
        hashSource_ = fileHashSource_.get();
    }
    if (hashSource_) hashJob_.reset(new (std::nothrow) HashJob(*hashSource_,digest_,prefix,received_));
    if (!hashJob_) { error(500,"internal_error",PSTR("Insufficient memory to validate the upload.")); return; }
    finalizing_ = true;
}
void DeviceHttpServer::finishAnimationChunkRequest(std::uint64_t now) {
    if (!animationChunkWriting_) return;
    const auto before = animationUpload_.receivedBytes();
    const auto result = animationUpload_.step(now,chunk_.data(),chunk_.size());
    diagnostics_.uploadBytes += animationUpload_.receivedBytes() - before;
    if (result == AnimationChunkResult::Pending) {
        if (clientActive_) lastActivity_ = now;
        return;
    }
    animationChunkWriting_ = false;
    animationChunkBody_.reset();
    if (!clientActive_ || animationChunkDetached_) {
        animationChunkDetached_ = false;
        finalizing_ = false;
        return;
    }
    if (result != AnimationChunkResult::Accepted && result != AnimationChunkResult::IdenticalReplay) {
        if (result == AnimationChunkResult::Failed) error(500,"internal_error",PSTR("The animation chunk could not be read or written."));
        else error(409,"conflict",PSTR("The animation chunk conflicts with the upload session."));
        return;
    }
    finalizing_ = false;
    response_ = {}; response_.statusCode = 204; prepareResponse();
}

void DeviceHttpServer::dispatchAnimationV2() {
    const auto now = lastActivity_;
    if (animationV2Request_ == AnimationV2Request::capabilities) {
        response_ = {}; response_.statusCode = 200; response_.contentType = "application/json";
        const int written = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"formats\":[\"nbif-v1\",\"nbif-v2\"],\"width\":240,\"height\":240,"
            "\"maxFrames\":20,\"maxDurationMs\":30000,\"maxEncodedBytes\":%lu,"
            "\"maxChunkBytes\":%lu,\"reserveBytes\":%lu,\"freeStorageBytes\":%llu}"),
            static_cast<unsigned long>(ANIMATION_UPLOAD_MAX_BYTES),
            static_cast<unsigned long>(ANIMATION_UPLOAD_MAX_CHUNK_BYTES),
            static_cast<unsigned long>(ANIMATION_UPLOAD_RESERVE_BYTES),
            static_cast<unsigned long long>(storage_.freeBytes()));
        if (written < 0 || static_cast<std::size_t>(written) >= response_.body.size()) {
            error(500,"internal_error",PSTR("Media capabilities are unavailable.")); return;
        }
        response_.bodySize = static_cast<std::size_t>(written); prepareResponse(); return;
    }
    if (animationV2Request_ == AnimationV2Request::begin) {
        std::uint32_t sizeBytes = 0;
        std::string_view hash;
        if (!parseAnimationBegin({bodyData(),received_},sizeBytes,hash) || sizeBytes == 0) {
            error(400,"invalid_request",PSTR("Provide sizeBytes and a lowercase SHA-256 digest.")); return;
        }
        if (sizeBytes > ANIMATION_UPLOAD_MAX_BYTES) { error(413,"payload_too_large",PSTR("The animation exceeds the NBIF v2 limit.")); return; }
        ++animationUploadIdCounter_;
        std::uint32_t uploadId = static_cast<std::uint32_t>(now) ^ ESP.getChipId() ^ animationUploadIdCounter_;
        if (uploadId == 0) uploadId = animationUploadIdCounter_ ? animationUploadIdCounter_ : 1;
        const auto result = animationUpload_.begin(uploadId,sizeBytes,hash,now,storage_.animationRevision);
        if (result == AnimationChunkResult::InsufficientStorage) {
            error(507,"insufficient_storage",PSTR("The animation and safe replacement reserve do not fit in LittleFS.")); return;
        }
        if (result != AnimationChunkResult::Accepted) {
            error(409,"conflict",PSTR("An animation session is active or storage cannot reserve the replacement.")); return;
        }
        char id[9]; snprintf_P(id,sizeof(id),PSTR("%08lx"),static_cast<unsigned long>(uploadId));
        response_ = {}; response_.statusCode = 201; response_.contentType = "application/json";
        response_.bodySize = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"uploadId\":\"%s\",\"nextOffset\":0,\"state\":\"receiving\"}"),id);
        prepareResponse(); return;
    }
    if (animationV2Request_ == AnimationV2Request::chunk) {
        error(500,"internal_error",PSTR("The animation chunk was not dispatched correctly.")); return;
    }
    if (animationV2Request_ == AnimationV2Request::complete) {
        if (!animationUpload_.owns(animationUploadId_)) { error(404,"not_found",PSTR("The animation upload session was not found.")); return; }
        if (animationUpload_.state() == AnimationUploadState::Receiving) {
            const auto result = animationUpload_.complete(animationUploadId_,now);
            if (result != AnimationChunkResult::Accepted) { error(409,"conflict",PSTR("The animation upload is incomplete or has a pending chunk.")); return; }
            hashJob_.reset(new (std::nothrow) HashJob(candidateSource_,digest_,0,animationUpload_.expectedBytes()));
            if (!hashJob_) {
                animationUpload_.fail(AnimationUploadError::ReadFailed,now);
                error(500,"internal_error",PSTR("The animation could not be scheduled for verification.")); return;
            }
            animationValidationHashDone_ = false;
            animationValidationOpened_ = false;
        } else if (animationUpload_.state() != AnimationUploadState::Verifying &&
                   animationUpload_.state() != AnimationUploadState::Ready &&
                   animationUpload_.state() != AnimationUploadState::Installed) {
            error(409,"conflict",PSTR("The animation upload cannot be completed in its current state.")); return;
        }
        response_ = {}; response_.statusCode = 202; response_.contentType = "application/json";
        response_.bodySize = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"uploadId\":\"%08lx\",\"nextOffset\":%lu,\"state\":\"%s\"}"),
            static_cast<unsigned long>(animationUploadId_),static_cast<unsigned long>(animationUpload_.receivedBytes()),
            animationUploadStateName(animationUpload_.state()));
        prepareResponse(); return;
    }
    if (animationV2Request_ == AnimationV2Request::status) {
        if (!animationUpload_.owns(animationUploadId_)) { error(404,"not_found",PSTR("The animation upload session was not found.")); return; }
        if (animationUpload_.state() == AnimationUploadState::Ready && storage_.animationPromotionFailed()) {
            animationUpload_.fail(AnimationUploadError::PromotionFailed,now);
        } else if (animationUpload_.state() == AnimationUploadState::Ready &&
                   storage_.animationRevision != animationUpload_.installedGeneration()) {
            animationUpload_.markInstalled(now);
        }
        response_ = {}; response_.statusCode = 200; response_.contentType = "application/json";
        const auto errorName = animationUploadErrorName(animationUpload_.error());
        response_.bodySize = snprintf_P(response_.body.data(),response_.body.size(),PSTR("{\"uploadId\":\"%08lx\",\"state\":\"%s\",\"nextOffset\":%lu,"
            "\"expectedBytes\":%lu,\"receivedBytes\":%lu,\"error\":\"%s\"}"),
            static_cast<unsigned long>(animationUploadId_),animationUploadStateName(animationUpload_.state()),
            static_cast<unsigned long>(animationUpload_.receivedBytes()),
            static_cast<unsigned long>(animationUpload_.expectedBytes()),
            static_cast<unsigned long>(animationUpload_.receivedBytes()),errorName);
        prepareResponse(); return;
    }
    if (animationV2Request_ == AnimationV2Request::cancel) {
        const auto result = animationUpload_.cancel(animationUploadId_,now);
        if (result == AnimationChunkResult::NotFound) { error(404,"not_found",PSTR("The animation upload session was not found.")); return; }
        if (result != AnimationChunkResult::Accepted) { error(409,"conflict",PSTR("The installed animation cannot be cancelled.")); return; }
        response_ = {}; response_.statusCode = 204; prepareResponse(); return;
    }
    error(400,"invalid_request",PSTR("The animation upload request is invalid."));
}

void DeviceHttpServer::advanceAnimationValidation(std::uint64_t now) {
    if (animationUpload_.state() != AnimationUploadState::Verifying) return;
    if (!animationValidationHashDone_) {
        const auto result = hashJob_ ? hashJob_->step(chunk_.data(),chunk_.size()) : HashStep::failed;
        if (result == HashStep::pending) { animationUpload_.noteValidationProgress(now); return; }
        if (result == HashStep::failed) {
            hashJob_.reset(); animationUpload_.fail(AnimationUploadError::ReadFailed,now); return;
        }
        char actualHash[64]; digest_.finish(actualHash);
        hashJob_.reset();
        if (std::string_view(actualHash,sizeof(actualHash)) != animationUpload_.sha256()) {
            animationUpload_.fail(AnimationUploadError::ChecksumMismatch,now); return;
        }
        animationValidationHashDone_ = true;
        animationUpload_.noteValidationProgress(now);
    }
    if (!animationValidationOpened_) {
        AnimationV2Metadata metadata{};
        if (!validationDecoder_.open(metadata)) {
            animationUpload_.fail(AnimationUploadError::InvalidAnimation,now); return;
        }
        animationValidationOpened_ = true;
        animationUpload_.noteValidationProgress(now);
        return;
    }
    const auto result = validationDecoder_.step();
    switch (result) {
        case AnimationDecodeStatus::Progress:
        case AnimationDecodeStatus::FrameComplete:
            animationUpload_.noteValidationProgress(now);
            break;
        case AnimationDecodeStatus::RowReady:
            validationDecoder_.consumeRow();
            animationUpload_.noteValidationProgress(now);
            break;
        case AnimationDecodeStatus::AnimationComplete:
            animationUpload_.markReady(now);
            animationValidationOpened_ = false;
            break;
        case AnimationDecodeStatus::Error:
            animationUpload_.fail(AnimationUploadError::InvalidAnimation,now);
            animationValidationOpened_ = false;
            break;
    }
}
void DeviceHttpServer::tick(std::uint64_t now) {
    if (lastTickValid_ && now >= lastTick_) {
        diagnostics_.maxLoopGapMs = std::max(diagnostics_.maxLoopGapMs,
            static_cast<std::uint32_t>(std::min<std::uint64_t>(now-lastTick_,0xffffffffULL)));
    }
    lastTick_ = now; lastTickValid_ = true;
    if (animationUpload_.expire(now)) {
        hashJob_.reset(); animationValidationHashDone_ = animationValidationOpened_ = false;
        if (!animationUpload_.hasPendingChunk()) { animationChunkBody_.reset(); animationChunkWriting_ = false; }
    }
    if (animationUpload_.state() == AnimationUploadState::Ready && storage_.animationPromotionFailed()) {
        animationUpload_.fail(AnimationUploadError::PromotionFailed,now);
    } else if (animationUpload_.state() == AnimationUploadState::Ready &&
               storage_.animationRevision != animationUpload_.installedGeneration()) {
        animationUpload_.markInstalled(now);
    }
    advanceAnimationValidation(now);
    if (rebootPending_) {
        if (!restartAt_) restartAt_ = now+2000;
        if (now >= restartAt_) { client_.stop(); ESP.restart(); return; }
        // Do not accept another mutation after Update.end schedules the boot copy.
        if (!sending_) return;
    }
    if (clientActive_ && !client_) {
        ++diagnostics_.connectionsDisconnected;
        close();
        if (rebootPending_) return;
    }
    if (!clientActive_ && animationChunkWriting_ && animationUpload_.hasPendingChunk()) {
        finishAnimationChunkRequest(now);
        return;
    }
    if (!clientActive_) {
        if (rebootPending_) return;
        client_ = server_.accept(); if (!client_) return;
        clientActive_ = true; ++diagnostics_.connectionsAccepted;
        client_.setNoDelay(true); client_.setTimeout(10); started_ = lastActivity_ = now;
    }
    if (!finalizing_ && now-lastActivity_ > 5000) { ++diagnostics_.idleTimeouts; close(); return; }
    if (now-started_ > requestDeadlineMs_) { ++diagnostics_.totalTimeouts; close(); return; }
    if (!client_.connected() && !client_.available()) { ++diagnostics_.connectionsDisconnected; close(); return; }
    if (finalizing_) {
        if (animationChunkWriting_) { finishAnimationChunkRequest(now); return; }
        if (maintenanceFirmware_ && !maintenanceOtaBodyHasNoExtraBytes(received_,headers_.contentLength,static_cast<std::size_t>(std::max(0,client_.available())))) {
            error(400,"invalid_request",PSTR("The firmware body must match Content-Length exactly.")); return;
        }
        lastActivity_ = now; finishBinary(); return;
    }
    if (sending_) {
        const auto capacity = client_.availableForWrite(); if (capacity <= 0) return;
        const char* source; std::size_t remaining;
        if (sent_ < responseHeaderSize_) { source = responseHeaders_.data()+sent_; remaining = responseHeaderSize_-sent_; }
        else { source = response_.body.data()+sent_-responseHeaderSize_; remaining = response_.bodySize-(sent_-responseHeaderSize_); }
        if (!remaining) { close(); return; }
        const auto count = std::min<std::size_t>({remaining,std::size_t(capacity),512});
        const auto written = client_.write(reinterpret_cast<const std::uint8_t*>(source),count);
        if (written) { sent_ += written; lastActivity_ = now; }
        return;
    }
    std::size_t budget = 512;
    while (budget && client_.available() && !readingBody_ && !sending_) {
        const char c = client_.read(); --budget; lastActivity_ = now;
        if (headerSize_ == headerBytes_.size()) { error(413,"payload_too_large",PSTR("Request headers exceed 4096 bytes.")); return; }
        headerBytes_[headerSize_++] = c;
        if (headerSize_ >= 4 && std::string_view(headerBytes_.data()+headerSize_-4,4) == "\r\n\r\n") headersComplete();
    }
    if (!readingBody_ || sending_ || !budget) return;
    const auto count = std::min<std::size_t>({budget,std::size_t(client_.available()),std::size_t(headers_.contentLength-received_)});
    if (!count) return;
    const auto bytes = client_.read(chunk_.data(),count);
    if (bytes <= 0) return;
    lastActivity_ = now;
    if (binary_) {
        if (!activeTransfer_->append(chunk_.data(),bytes)) { error(500,"internal_error",PSTR("The staged upload could not be written.")); return; }
        diagnostics_.uploadBytes += static_cast<std::uint32_t>(bytes);
    } else if (animationV2Route_ && animationV2Request_ == AnimationV2Request::chunk) {
        if (!animationChunkBody_) { error(500,"internal_error",PSTR("The upload chunk buffer is unavailable.")); return; }
        memcpy(animationChunkBody_.get()+received_,chunk_.data(),bytes);
    } else memcpy(bodyData()+received_,chunk_.data(),bytes);
    received_ += bytes;
    if (received_ == headers_.contentLength) bodyComplete();
}
} // namespace neonbyte
#endif
