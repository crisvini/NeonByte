#include <unity.h>
#include "neonbyte/safe_startup.h"
#include "neonbyte/ota_staging.h"
#include "neonbyte/recovery_ap.h"
#include "neonbyte/startup_guard_layout.h"
#include <string>
#include <cstring>
using namespace neonbyte;
namespace {
// Test-only identities. No test fixture is linked into an ESP8266 artifact.
constexpr RecoveryIdentity IDENTITY{"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "fedcba9876543210fedcba9876543210"};
struct ApBackend {
    bool startOk = true, configureOk = true, readOk = true, addressMatches = true;
    bool disabled = false, started = false, configured = false;
    bool startProtectedAp() { started = true; return startOk; }
    bool configureNetwork() { configured = true; return configureOk; }
    bool networkMatches() { return readOk && addressMatches; }
    void disableAp() { disabled = true; }
};
void testRecoveryApRejectsSdkFailuresAndMismatchedNetwork() {
    for (unsigned fault=0;fault<4;++fault) {
        ApBackend backend;
        backend.startOk = fault != 0;
        backend.configureOk = fault != 1;
        backend.readOk = fault != 2;
        backend.addressMatches = fault != 3;
        TEST_ASSERT_FALSE(startCheckedRecoveryAp(backend));
        TEST_ASSERT_TRUE(backend.disabled);
    }
    ApBackend backend;
    TEST_ASSERT_TRUE(startCheckedRecoveryAp(backend));
    TEST_ASSERT_TRUE(backend.started);
    TEST_ASSERT_TRUE(backend.configured);
    TEST_ASSERT_FALSE(backend.disabled);
}
class Services final : public StartupServices {
public:
    std::string calls;
    bool httpOk = true, apOk = true, mountOk = true, loadOk = true, saveOk = true, appOk = true, guardOk = true, clearGuardOk = true, connected = false, backgroundAllowed = true;
    unsigned attempts = 0, saves = 0;
    unsigned configurationMounts = 0, preparationMounts = 0;
    WifiCredentials stored{}, target{};
    Services() { strcpy(stored.ssid,"Previous"); strcpy(stored.password,"previous-password"); }
    bool startRecoveryAp(RecoveryIdentity) override { calls += 'N'; return apOk; }
    bool startHttp() override { calls += 'H'; return httpOk; }
    bool mountConfigurationStorage() override { ++configurationMounts; calls += 'Q'; return mountOk; }
    bool mountStorage() override { ++preparationMounts; calls += 'F'; return mountOk; }
    bool loadWifi(WifiCredentials& out) override { calls += 'C'; out = stored; return loadOk; }
    bool saveWifi(const WifiCredentials& value) override { ++saves; if (!saveOk) return false; stored = value; return true; }
    void connectStation(const WifiCredentials& value) override { ++attempts; target = value; connected = false; calls += 'W'; }
    bool stationConnected(const WifiCredentials& value) const override { return connected && std::string(value.ssid) == target.ssid; }
    bool backgroundStartupWorkAllowed() const override { return backgroundAllowed; }
    bool setStartupGuard(bool risky) override { calls += risky ? 'G' : 'g'; return guardOk && (risky || clearGuardOk); }
    bool startApplication() override { calls += 'A'; return appOk; }
    void stopApplication() override { calls += 'S'; }
};
void testNetworkAndHttpStartBeforeStorageAndDisplay() {
    Services services; SafeStartup startup(services,IDENTITY);
    startup.begin(0,false); TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    startup.tick(9999); TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    startup.tick(10000); TEST_ASSERT_TRUE(startup.applicationRunning());
    TEST_ASSERT_TRUE(services.calls.find('F') > services.calls.find('H'));
    TEST_ASSERT_TRUE(services.calls.find('A') > services.calls.find('H'));
    TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testAutomaticPowerOnStartsOnceWithoutWifiAndSoftwareRestartRemainsInMaintenance() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,startupMaintenanceOnBoot(false,StartupResetReason::powerOn));
    startup.tick(9999); TEST_ASSERT_FALSE(startup.applicationRunning());
    startup.tick(10000); TEST_ASSERT_TRUE(startup.applicationRunning());
    TEST_ASSERT_FALSE(startup.stationConnected());
    TEST_ASSERT_EQUAL(1,services.attempts);
    startup.tick(40000); startup.tick(70000);
    TEST_ASSERT_EQUAL(3,services.attempts);
    TEST_ASSERT_EQUAL(services.calls.find('A'),services.calls.rfind('A'));
    TEST_ASSERT_TRUE(startup.recoveryApRunning());

    Services rebootServices;
    SafeStartup reboot(rebootServices,IDENTITY);
    reboot.begin(0,false,startupMaintenanceOnBoot(false,StartupResetReason::softRestart));
    reboot.tick(10000); reboot.tick(120000);
    TEST_ASSERT_FALSE(reboot.applicationRunning());
    TEST_ASSERT_TRUE(reboot.applicationPaused());
    TEST_ASSERT_TRUE(reboot.configurationLoaded());
    TEST_ASSERT_EQUAL(0,rebootServices.preparationMounts);
    TEST_ASSERT_TRUE(rebootServices.attempts > 0);
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,reboot.runApplication("Bearer invalid"));
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::ok,reboot.runApplication(auth));
    TEST_ASSERT_TRUE(reboot.applicationRunning());
}
void testAutomaticStartupPolicyPreservesExplicitMaintenanceAndUnexpectedResetGuards() {
    for (auto reason : {StartupResetReason::powerOn, StartupResetReason::softRestart,
                        StartupResetReason::externalReset, StartupResetReason::unexpected}) {
        TEST_ASSERT_TRUE(startupMaintenanceOnBoot(true,reason));
        if (reason != StartupResetReason::powerOn) TEST_ASSERT_TRUE(startupMaintenanceOnBoot(false,reason));
        Services services; SafeStartup startup(services,IDENTITY);
        startup.begin(0,true,startupMaintenanceOnBoot(false,reason));
        startup.tick(120000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_FALSE(startup.configurationLoaded());
        TEST_ASSERT_EQUAL(0,services.attempts);
        TEST_ASSERT_TRUE(startup.recoveryApRunning());
    }
    Services services; services.appOk = false;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,startupMaintenanceOnBoot(false,StartupResetReason::powerOn));
    startup.tick(10000); const auto calls = services.calls;
    startup.tick(20000); startup.tick(25000);
    TEST_ASSERT_EQUAL_STRING(calls.c_str(),services.calls.c_str());
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testFailedRecoveryNetworkRequiresFreshWindowBeforeMaintenanceConfigurationLoad() {
    for (unsigned fault=0;fault<2;++fault) {
        Services services;
        services.apOk = fault != 0; services.httpOk = fault != 1;
        SafeStartup startup(services,IDENTITY);
        startup.begin(0,false,true);
        startup.tick(4999);
        TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
        startup.tick(5000); startup.tick(10000); startup.tick(60000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
        TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('G'));
        TEST_ASSERT_FALSE(startup.configurationLoaded());
        // Successful recovery must provide a fresh maintenance window.
        services.apOk = services.httpOk = true;
        startup.tick(65000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        startup.tick(74999);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_FALSE(startup.configurationLoaded());
        startup.tick(75000);
        TEST_ASSERT_TRUE(startup.configurationLoaded());
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_EQUAL(0,services.preparationMounts);
    }
}
void testHttpStartupRetriesThenUsesFreshMaintenanceWindowForConfiguration() {
    Services services; services.httpOk = false;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,true);
    startup.tick(4999);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    startup.tick(5000);
    TEST_ASSERT_EQUAL_STRING("NHH",services.calls.c_str());
    startup.tick(9999);
    TEST_ASSERT_EQUAL_STRING("NHH",services.calls.c_str());
    services.httpOk = true; startup.tick(10000);
    TEST_ASSERT_FALSE(startup.configurationLoaded());
    startup.tick(19999);
    TEST_ASSERT_FALSE(startup.configurationLoaded());
    startup.tick(20000);
    TEST_ASSERT_TRUE(startup.configurationLoaded());
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(1,services.configurationMounts);
    TEST_ASSERT_EQUAL(0,services.preparationMounts);
    TEST_ASSERT_EQUAL(1,services.attempts);
}
void testMaintenanceBootLoadsConfigurationOnlyAndExplicitRunPreparesStorage() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,true);
    startup.tick(60000);
    TEST_ASSERT_TRUE(startup.configurationLoaded());
    TEST_ASSERT_EQUAL(1,services.configurationMounts);
    TEST_ASSERT_EQUAL(0,services.preparationMounts);
    TEST_ASSERT_EQUAL(1,services.attempts);
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_TRUE(startup.applicationPaused());
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.runApplication("Bearer invalid"));
    TEST_ASSERT_EQUAL(0,services.preparationMounts);
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.runApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(1,services.preparationMounts);
}
void testCleanMaintenanceBootLoadsSavedWifiWithoutStartingApplication() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,true);
    startup.tick(9999);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    startup.tick(10000);
    TEST_ASSERT_TRUE(startup.configurationLoaded());
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(1,services.attempts);
    TEST_ASSERT_EQUAL_STRING("Previous",services.target.ssid);
    startup.tick(120000);
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testCrashEvidencePreventsMaintenanceBootConfigurationLoad() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,true,true);
    startup.tick(120000);
    TEST_ASSERT_FALSE(startup.configurationLoaded());
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(0,services.attempts);
    TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
    TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('G'));
}
void testInvalidStoredWifiDoesNotAttemptStationAssociation() {
    Services services;
    strcpy(services.stored.password,"short");
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false);
    startup.tick(10000);
    startup.tick(40000);
    TEST_ASSERT_FALSE(startup.configurationLoaded());
    TEST_ASSERT_EQUAL(0,services.attempts);
}
void testMaintenanceConfigurationFaultsAreSingleAttemptAndFailClosed() {
    for (unsigned fault=0;fault<3;++fault) {
        Services services;
        services.mountOk = fault != 0;
        services.loadOk = fault != 1;
        services.clearGuardOk = fault != 2;
        SafeStartup startup(services,IDENTITY);
        startup.begin(0,false,true);
        startup.tick(10000);
        startup.tick(70000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_EQUAL(0,services.attempts);
        TEST_ASSERT_EQUAL(1,services.configurationMounts);
        TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
        if (fault == 0) TEST_ASSERT_FALSE(startup.storageAvailable());
        if (fault == 1 || fault == 2) TEST_ASSERT_FALSE(startup.configurationLoaded());
    }
}
void testStagedWifiCancelsPendingMaintenanceConfigurationLoad() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    startup.begin(0,false,true);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(authorization,"ssid=Temporary&password=temp-password",true,9999));
    startup.tick(10000);
    TEST_ASSERT_EQUAL(0,services.configurationMounts);
    TEST_ASSERT_EQUAL(1,services.attempts);
    TEST_ASSERT_EQUAL_STRING("Temporary",services.target.ssid);
    TEST_ASSERT_FALSE(startup.applicationRunning());
}
void testMaintenanceBootProvisioningAndColdRestartRemainExplicit() {
    Services services;
    services.loadOk = false;
    SafeStartup startup(services,IDENTITY);
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    startup.begin(0,false,true);
    startup.tick(60000);
    TEST_ASSERT_FALSE(startup.configurationLoaded());
    TEST_ASSERT_EQUAL(1,services.configurationMounts);
    TEST_ASSERT_EQUAL(0,services.preparationMounts);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(authorization,"ssid=Network&password=examplepass",false,60000));
    services.connected = true;
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.confirmWifi(authorization));
    startup.tick(120000);
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.runApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationRunning());
    Services rebooted;
    SafeStartup selected(rebooted,IDENTITY);
    selected.begin(0,false,true);
    selected.tick(120000);
    TEST_ASSERT_TRUE(selected.configurationLoaded());
    TEST_ASSERT_EQUAL(1,rebooted.configurationMounts);
    TEST_ASSERT_EQUAL(1,rebooted.attempts);
    Services existing;
    SafeStartup normal(existing,IDENTITY);
    normal.begin(0,false);
    normal.tick(10000);
    TEST_ASSERT_TRUE(normal.applicationRunning());
}
void testMaintenanceOtaAdmissionRejectsPendingAutomaticStartup() {
    Services services; SafeStartup startup(services,IDENTITY);
    startup.begin(0,false);
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_FALSE(startup.applicationPaused());
    const auto admission = maintenanceOtaAdmission(startup.authorized(authorization),startup.applicationPaused(),true,
        HttpMethod::put,"application/octet-stream",0x1030,std::string(64,'a'));
    TEST_ASSERT_EQUAL(OtaAdmissionError::applicationRunning,admission);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.pauseApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationPaused());
    TEST_ASSERT_EQUAL(OtaAdmissionError::none,
        maintenanceOtaAdmission(startup.authorized(authorization),startup.applicationPaused(),true,
            HttpMethod::put,"application/octet-stream",0x1030,std::string(64,'a')));
    startup.tick(10000);
    TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
    TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('G'));
}
void testMissingOrMalformedIdentityNeverStartsNetwork() {
    for (auto identity : {RecoveryIdentity{}, RecoveryIdentity{"short",IDENTITY.apPassword},
        RecoveryIdentity{IDENTITY.token,"00000000000000000000000000000000"},
        RecoveryIdentity{IDENTITY.token,IDENTITY.token.substr(0,32)}}) {
        Services services; SafeStartup startup(services,identity); startup.begin(0,false); startup.tick(60000);
        TEST_ASSERT_FALSE(startup.identityValid()); TEST_ASSERT_TRUE(services.calls.empty());
    }
}
void testMountConfigurationAndApplicationFailuresKeepRecoveryAvailable() {
    for (unsigned fault=0;fault<4;++fault) {
        Services services; services.mountOk = fault != 0; services.loadOk = fault != 1;
        services.appOk = fault != 2; services.guardOk = fault != 3;
        SafeStartup startup(services,IDENTITY); startup.begin(0,false); startup.tick(10000);
        TEST_ASSERT_FALSE(startup.applicationRunning()); TEST_ASSERT_TRUE(startup.recoveryApRunning());
        TEST_ASSERT_EQUAL_STRING("NH",services.calls.substr(0,2).c_str());
        if (fault == 3) TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
    }
}
void testCrashBootStaysInMaintenanceUntilAuthenticatedRun() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,true); startup.tick(10000);
    TEST_ASSERT_FALSE(startup.applicationRunning()); TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.runApplication("Bearer wrong"));
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.runApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.pauseApplication("")); TEST_ASSERT_TRUE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.pauseApplication(authorization)); TEST_ASSERT_FALSE(startup.applicationRunning());
    startup.tick(90000); TEST_ASSERT_FALSE(startup.applicationRunning());
}
void testApAndStationRetryAreBoundedAndApRemainsAfterConnection() {
    Services services; services.apOk = false;
    SafeStartup startup(services,IDENTITY); startup.begin(0,false); startup.tick(4999);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    services.apOk = true; startup.tick(5000); TEST_ASSERT_TRUE(startup.recoveryApRunning());
    startup.tick(10000); TEST_ASSERT_EQUAL(0,services.attempts);
    startup.tick(15000); TEST_ASSERT_EQUAL(1,services.attempts);
    startup.tick(44999); TEST_ASSERT_EQUAL(1,services.attempts);
    startup.tick(45000); TEST_ASSERT_EQUAL(2,services.attempts);
    services.connected = true; startup.tick(70000); TEST_ASSERT_EQUAL(2,services.attempts);
    TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testProvisioningRequiresAuthenticationAndExplicitConnectedConfirmation() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,false);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.stageWifi("", "ssid=New&password=new-password",false,1));
    TEST_ASSERT_EQUAL(StartupResult::invalid,startup.stageWifi(auth,"ssid=New&password=short",false,1));
    TEST_ASSERT_EQUAL(0,services.attempts);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(auth,"ssid=New&password=new-password",false,1));
    TEST_ASSERT_EQUAL(0,services.saves); TEST_ASSERT_TRUE(startup.pendingWifi());
    TEST_ASSERT_EQUAL(StartupResult::conflict,startup.confirmWifi(auth)); TEST_ASSERT_EQUAL(0,services.saves);
    services.connected = true; strcpy(services.target.ssid,"Wrong");
    TEST_ASSERT_EQUAL(StartupResult::conflict,startup.confirmWifi(auth));
    strcpy(services.target.ssid,"New");
    // Storage has not been accessed yet; confirmation initializes it behind a guard.
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.confirmWifi(auth));
    TEST_ASSERT_EQUAL(1,services.saves); TEST_ASSERT_EQUAL_STRING("New",services.stored.ssid);
    TEST_ASSERT_FALSE(startup.pendingWifi()); TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testFailedPersistencePreservesPreviousAndTemporaryWifiRequiresExplicitChoice() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,false); startup.tick(10000);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    services.saveOk = false;
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(auth,"ssid=New&password=new-password",false,10001));
    services.connected = true;
    TEST_ASSERT_EQUAL(StartupResult::storageUnavailable,startup.confirmWifi(auth));
    TEST_ASSERT_EQUAL_STRING("Previous",services.stored.ssid); TEST_ASSERT_TRUE(startup.pendingWifi());
    TEST_ASSERT_FALSE(startup.volatileWifi());
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(auth,"ssid=Temporary&password=temp-password",true,10002));
    services.connected = true; TEST_ASSERT_EQUAL(StartupResult::ok,startup.confirmWifi(auth));
    TEST_ASSERT_TRUE(startup.volatileWifi()); TEST_ASSERT_EQUAL_STRING("Previous",services.stored.ssid);
    Services reboot; reboot.stored = services.stored;
    SafeStartup restarted(reboot,IDENTITY); restarted.begin(0,false); restarted.tick(10000);
    TEST_ASSERT_EQUAL_STRING("Previous",reboot.target.ssid); TEST_ASSERT_FALSE(restarted.volatileWifi());
}
void testUnmountableStorageStillAllowsTemporaryProvisioningAndRejectsApplication() {
    Services services; services.mountOk = false;
    SafeStartup startup(services,IDENTITY); startup.begin(0,false); startup.tick(10000);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.stageWifi(auth,"ssid=Temporary&password=temp-password",true,10001));
    services.connected = true; TEST_ASSERT_EQUAL(StartupResult::ok,startup.confirmWifi(auth));
    TEST_ASSERT_EQUAL(0,services.saves); TEST_ASSERT_TRUE(startup.volatileWifi());
    TEST_ASSERT_EQUAL(StartupResult::storageUnavailable,startup.runApplication(auth));
    TEST_ASSERT_TRUE(startup.recoveryApRunning());
}
void testMaintenanceRoutesAuthenticateReadsAndMutationsWithoutEchoingSecrets() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,true);
    HttpResponse response;
    for (auto path : {"/maintenance/v1/status","/maintenance/v1/run","/maintenance/v1/pause",
        "/maintenance/v1/wifi","/maintenance/v1/wifi/temporary","/maintenance/v1/wifi/confirm"}) {
        handleMaintenance({HttpMethod::post,path,"","",""},startup,0,response);
        TEST_ASSERT_EQUAL(401,response.statusCode); TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    }
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    handleMaintenance({HttpMethod::get,"/maintenance/v1/status",auth,"",""},startup,0,response);
    TEST_ASSERT_EQUAL(200,response.statusCode);
    TEST_ASSERT_TRUE(response.bodyView().find("\"applicationRunning\":false") != std::string_view::npos);
    TEST_ASSERT_TRUE(response.bodyView().find(IDENTITY.token) == std::string_view::npos);
    TEST_ASSERT_TRUE(response.bodyView().find(IDENTITY.apPassword) == std::string_view::npos);
    handleMaintenance({HttpMethod::put,"/maintenance/v1/wifi",auth,"application/x-www-form-urlencoded","ssid=New&password=new-password"},startup,1,response);
    TEST_ASSERT_EQUAL(204,response.statusCode); TEST_ASSERT_EQUAL(0,response.bodySize);
    handleMaintenance({HttpMethod::post,"/maintenance/v1/wifi/confirm",auth,"",""},startup,1,response);
    TEST_ASSERT_EQUAL(409,response.statusCode); TEST_ASSERT_EQUAL(0,services.saves);
    services.connected = true;
    handleMaintenance({HttpMethod::post,"/maintenance/v1/wifi/confirm",auth,"",""},startup,2,response);
    TEST_ASSERT_EQUAL(204,response.statusCode);
    handleMaintenance({HttpMethod::post,"/maintenance/v1/run",auth,"",""},startup,3,response);
    TEST_ASSERT_EQUAL(204,response.statusCode); TEST_ASSERT_TRUE(startup.applicationRunning());
    handleMaintenance({HttpMethod::post,"/maintenance/v1/pause",auth,"",""},startup,4,response);
    TEST_ASSERT_EQUAL(204,response.statusCode); TEST_ASSERT_FALSE(startup.applicationRunning());
}
void testMaintenanceRejectsWrongMethodsLargeBodiesAndMalformedForms() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,true);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    HttpResponse response;
    handleMaintenance({HttpMethod::get,"/maintenance/v1/run",auth,"",""},startup,0,response);
    TEST_ASSERT_EQUAL(400,response.statusCode);
    handleMaintenance({HttpMethod::post,"/maintenance/v1/pause",auth,"","unexpected"},startup,0,response);
    TEST_ASSERT_EQUAL(400,response.statusCode);
    handleMaintenance({HttpMethod::put,"/maintenance/v1/wifi",auth,"application/json","{}"},startup,0,response);
    TEST_ASSERT_EQUAL(400,response.statusCode);
    handleMaintenance({HttpMethod::put,"/maintenance/v1/wifi",auth,"application/x-www-form-urlencoded",std::string(513,'x')},startup,0,response);
    TEST_ASSERT_EQUAL(400,response.statusCode);
    TEST_ASSERT_EQUAL(0,services.attempts); TEST_ASSERT_EQUAL(0,services.saves);
}
void testGuardClearFailureDisablesApplicationAndKeepsNetwork() {
    Services services; SafeStartup startup(services,IDENTITY); startup.begin(0,false); startup.tick(10000);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    startup.pauseApplication(auth); services.clearGuardOk = false;
    TEST_ASSERT_EQUAL(StartupResult::applicationUnavailable,startup.runApplication(auth));
    TEST_ASSERT_FALSE(startup.applicationRunning()); TEST_ASSERT_TRUE(startup.recoveryApRunning());
}

void testExplicitStorageRetryDoesNotInitializeDisplayAndCanRecoverTransientMount() {
    Services services; services.mountOk = false;
    SafeStartup startup(services,IDENTITY); startup.begin(0,true);
    const std::string auth = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.prepareStorage(""));
    TEST_ASSERT_EQUAL(StartupResult::storageUnavailable,startup.prepareStorage(auth));
    services.mountOk = true;
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.prepareStorage(auth));
    TEST_ASSERT_TRUE(startup.storageAvailable()); TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('A'));
}

void testStationProofRejectsStaleStatusFailedDisconnectAndSameSsidPasswordChange() {
    WifiCredentials first; strcpy(first.ssid,"Same"); strcpy(first.password,"old-password");
    StationAssociation proof;
    proof.beginAttempt(first); proof.allowAttempt(true);
    TEST_ASSERT_FALSE(proof.confirmed(first,true)); // Configured SSID plus WL_CONNECTED is insufficient.
    proof.onGotIp(); TEST_ASSERT_FALSE(proof.confirmed(first,true));
    proof.onConnected("Wrong"); proof.onGotIp(); TEST_ASSERT_FALSE(proof.confirmed(first,true));
    proof.onConnected("Same"); proof.onGotIp(); TEST_ASSERT_TRUE(proof.confirmed(first,true));
    WifiCredentials second = first; strcpy(second.password,"new-password");
    proof.beginAttempt(second); // Same SSID, different password: previous association must not count.
    TEST_ASSERT_FALSE(proof.confirmed(second,true));
    proof.allowAttempt(false); proof.onConnected("Same"); proof.onGotIp();
    TEST_ASSERT_FALSE(proof.confirmed(second,true));
    proof.beginAttempt(second); proof.allowAttempt(true,false);
    proof.onConnected("Same"); proof.onGotIp(); TEST_ASSERT_FALSE(proof.confirmed(second,true));
    proof.beginAttempt(second); proof.allowAttempt(true);
    proof.onConnected("Same"); TEST_ASSERT_FALSE(proof.confirmed(second,true));
    proof.onGotIp(); TEST_ASSERT_TRUE(proof.confirmed(second,true));
    TEST_ASSERT_FALSE(proof.confirmed(first,true)); TEST_ASSERT_FALSE(proof.confirmed(second,false));
    proof.onDisconnected(); TEST_ASSERT_FALSE(proof.confirmed(second,true));
}

}
void setUp() {}
void tearDown() {}
int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(testNetworkAndHttpStartBeforeStorageAndDisplay);
    RUN_TEST(testAutomaticPowerOnStartsOnceWithoutWifiAndSoftwareRestartRemainsInMaintenance);
    RUN_TEST(testAutomaticStartupPolicyPreservesExplicitMaintenanceAndUnexpectedResetGuards);
    RUN_TEST(testFailedRecoveryNetworkRequiresFreshWindowBeforeMaintenanceConfigurationLoad);
    RUN_TEST(testHttpStartupRetriesThenUsesFreshMaintenanceWindowForConfiguration);
    RUN_TEST(testRecoveryApRejectsSdkFailuresAndMismatchedNetwork);
    RUN_TEST(testMaintenanceBootLoadsConfigurationOnlyAndExplicitRunPreparesStorage);
    RUN_TEST(testCleanMaintenanceBootLoadsSavedWifiWithoutStartingApplication);
    RUN_TEST(testCrashEvidencePreventsMaintenanceBootConfigurationLoad);
    RUN_TEST(testInvalidStoredWifiDoesNotAttemptStationAssociation);
    RUN_TEST(testMaintenanceConfigurationFaultsAreSingleAttemptAndFailClosed);
    RUN_TEST(testStagedWifiCancelsPendingMaintenanceConfigurationLoad);
    RUN_TEST(testMaintenanceBootProvisioningAndColdRestartRemainExplicit);
    RUN_TEST(testMaintenanceOtaAdmissionRejectsPendingAutomaticStartup);
    RUN_TEST(testMissingOrMalformedIdentityNeverStartsNetwork);
    RUN_TEST(testMountConfigurationAndApplicationFailuresKeepRecoveryAvailable);
    RUN_TEST(testCrashBootStaysInMaintenanceUntilAuthenticatedRun);
    RUN_TEST(testApAndStationRetryAreBoundedAndApRemainsAfterConnection);
    RUN_TEST(testProvisioningRequiresAuthenticationAndExplicitConnectedConfirmation);
    RUN_TEST(testFailedPersistencePreservesPreviousAndTemporaryWifiRequiresExplicitChoice);
    RUN_TEST(testUnmountableStorageStillAllowsTemporaryProvisioningAndRejectsApplication);
    RUN_TEST(testMaintenanceRoutesAuthenticateReadsAndMutationsWithoutEchoingSecrets);
    RUN_TEST(testMaintenanceRejectsWrongMethodsLargeBodiesAndMalformedForms);
    RUN_TEST(testGuardClearFailureDisablesApplicationAndKeepsNetwork);
    RUN_TEST(testExplicitStorageRetryDoesNotInitializeDisplayAndCanRecoverTransientMount);
    RUN_TEST(testStationProofRejectsStaleStatusFailedDisconnectAndSameSsidPasswordChange);
    return UNITY_END();
}
