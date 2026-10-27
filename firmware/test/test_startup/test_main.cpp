#include <unity.h>
#include "neonbyte/safe_startup.h"
#include "neonbyte/ota_staging.h"
#include "neonbyte/recovery_ap.h"
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
    bool httpOk = true, apOk = true, mountOk = true, loadOk = true, saveOk = true, appOk = true, guardOk = true, clearGuardOk = true, connected = false;
    unsigned attempts = 0, saves = 0;
    WifiCredentials stored{}, target{};
    Services() { strcpy(stored.ssid,"Previous"); strcpy(stored.password,"previous-password"); }
    bool startRecoveryAp(RecoveryIdentity) override { calls += 'N'; return apOk; }
    bool startHttp() override { calls += 'H'; return httpOk; }
    bool mountStorage() override { calls += 'F'; return mountOk; }
    bool loadWifi(WifiCredentials& out) override { calls += 'C'; out = stored; return loadOk; }
    bool saveWifi(const WifiCredentials& value) override { ++saves; if (!saveOk) return false; stored = value; return true; }
    void connectStation(const WifiCredentials& value) override { ++attempts; target = value; connected = false; calls += 'W'; }
    bool stationConnected(const WifiCredentials& value) const override { return connected && std::string(value.ssid) == target.ssid; }
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
void testFailedRecoveryNetworkPreventsAutomaticRiskyStartup() {
    for (unsigned fault=0;fault<2;++fault) {
        Services services;
        services.apOk = fault != 0; services.httpOk = fault != 1;
        SafeStartup startup(services,IDENTITY);
        startup.begin(0,false);
        startup.tick(4999);
        TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
        startup.tick(5000); startup.tick(10000); startup.tick(60000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('F'));
        TEST_ASSERT_EQUAL(std::string::npos,services.calls.find('G'));
        // Successful recovery must provide a fresh maintenance window.
        services.apOk = services.httpOk = true;
        startup.tick(65000);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        startup.tick(74999);
        TEST_ASSERT_FALSE(startup.applicationRunning());
        startup.tick(75000);
        TEST_ASSERT_TRUE(startup.applicationRunning());
    }
}
void testHttpStartupRetriesOnlyUntilListenerSucceeds() {
    Services services; services.httpOk = false;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,true);
    startup.tick(4999);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    startup.tick(5000);
    TEST_ASSERT_EQUAL_STRING("NHH",services.calls.c_str());
    startup.tick(9999);
    TEST_ASSERT_EQUAL_STRING("NHH",services.calls.c_str());
    services.httpOk = true; startup.tick(10000); startup.tick(60000);
    TEST_ASSERT_EQUAL_STRING("NHHH",services.calls.c_str());
    TEST_ASSERT_FALSE(startup.applicationRunning());
}
void testExplicitMaintenanceBootDoesNotMountUntilAuthorizedAndDefaultStillStarts() {
    Services services;
    SafeStartup startup(services,IDENTITY);
    startup.begin(0,false,true);
    startup.tick(60000);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    TEST_ASSERT_FALSE(startup.applicationRunning());
    TEST_ASSERT_TRUE(startup.applicationPaused());
    TEST_ASSERT_EQUAL(StartupResult::unauthorized,startup.runApplication("Bearer invalid"));
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    TEST_ASSERT_EQUAL(StartupResult::ok,startup.runApplication(authorization));
    TEST_ASSERT_TRUE(startup.applicationRunning());
}
void testMaintenanceBootProvisioningAndColdRestartRemainExplicit() {
    Services services;
    services.loadOk = false;
    SafeStartup startup(services,IDENTITY);
    const std::string authorization = "Bearer " + std::string(IDENTITY.token);
    startup.begin(0,false,true);
    startup.tick(60000);
    TEST_ASSERT_EQUAL_STRING("NH",services.calls.c_str());
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
    TEST_ASSERT_EQUAL_STRING("NH",rebooted.calls.c_str());
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
    RUN_TEST(testFailedRecoveryNetworkPreventsAutomaticRiskyStartup);
    RUN_TEST(testHttpStartupRetriesOnlyUntilListenerSucceeds);
    RUN_TEST(testRecoveryApRejectsSdkFailuresAndMismatchedNetwork);
    RUN_TEST(testExplicitMaintenanceBootDoesNotMountUntilAuthorizedAndDefaultStillStarts);
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
