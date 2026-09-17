// EXPERIMENT — not part of the shipped addon. Built by `make exp-provider`.
//
// THE QUESTION 0.3.0 HANGS ON: the shipped addon (src/addon.cc) creates a
// QCoreApplication and NEVER runs its event loop. liblogos' load calls are
// synchronous, so that works today. Publishing a provider object and SERVING
// RPC is a different animal: QRemoteObjects / QTcpServer deliver over queued
// connections, which need a running event loop. Running one inside Electron's
// main process is exactly the Qt/Chromium coexistence risk 0.1.0 dodged by
// never running one.
//
// So this addon does the smallest thing that can answer it:
//
//   publish(port, mode)   construct LogosAPI("exp_service", {tcp:port}),
//                         register a trivial LogosProviderObject, and drive
//                         the event loop in one of three ways:
//                           "none"    - no pumping at all (the 0.1.0 status quo)
//                           "pump"    - QCoreApplication::processEvents() from
//                                       a libuv timer on the JS thread
//                           "thread"  - a dedicated std::thread running
//                                       QEventLoop::exec()
//   tick()                one processEvents() pass, for mode "pump"
//
// A JS client (logos-js-sdk over plain TCP) then calls exp_service.echo().
// Whichever modes answer, answer the question.
#include <napi.h>

#include <QCoreApplication>
#include <QEventLoop>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QThread>
#include <QVariant>
#include <QVariantList>

#include <logos_api.h>
#include <logos_api_provider.h>
#include <logos_provider_object.h>
#include <logos_transport_config.h>
#include <token_manager.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>

namespace {

void EnsureQtApp() {
  if (QCoreApplication::instance() != nullptr) return;
  static int argc = 1;
  static char arg0[] = "exp-provider";
  static char* argv[] = {arg0, nullptr};
  new QCoreApplication(argc, argv);
}

// The smallest possible LogosProviderObject. Deliberately implements the
// UNIVERSAL (Qt-free) side plus the three Qt delegates, exactly as
// CoreServiceImpl does — so if this shape works, CoreServiceImpl's shape works.
class EchoProvider : public LogosProviderObject {
 public:
  // --- Qt interface: delegate to the std bridge, as core_service does ---
  QVariant callMethod(const QString& m, const QVariantList& a) override {
    return callMethodStdBridge(m, a);
  }
  QJsonArray getMethods() override { return getMethodsStdBridge(); }
  QString providerName() const override { return QStringLiteral("exp_service"); }
  QString providerVersion() const override { return QStringLiteral("1.0.0"); }
  void setEventListener(EventCallback cb) override { setEventListenerStdBridge(cb); }
  bool informModuleToken(const QString&, const QString&) override { return false; }
  void init(void*) override {}

  // --- Universal interface ---
  nlohmann::json callMethodStd(const std::string& method,
                               const nlohmann::json& args) override {
    std::fprintf(stderr, "[exp] callMethodStd(%s) on thread %p\n", method.c_str(),
                 (void*)QThread::currentThreadId());
    if (method == "echo") {
      nlohmann::json out;
      out["status"] = "ok";
      out["echo"] = args.empty() ? nlohmann::json(nullptr) : args[0];
      // Which thread served the call is the whole point: it tells us WHERE the
      // Qt dispatch runs, and therefore what a real core_service would have to
      // be thread-safe against.
      char buf[32];
      std::snprintf(buf, sizeof(buf), "%p", (void*)QThread::currentThreadId());
      out["served_on_thread"] = std::string(buf);
      return out;
    }
    if (method == "getStatus") {
      nlohmann::json out;
      out["alive"] = true;
      return out;
    }
    return nullptr;
  }

  std::vector<LogosMethodMetadata> getMethodsStd() override {
    std::vector<LogosMethodMetadata> methods;
    LogosMethodMetadata echo;
    echo.name = "echo";
    echo.returnType = "LogosMap";
    nlohmann::json p;
    p["name"] = "value";
    p["type"] = "string";
    echo.parameters = nlohmann::json::array({p});
    methods.push_back(echo);

    LogosMethodMetadata status;
    status.name = "getStatus";
    status.returnType = "LogosMap";
    status.parameters = nlohmann::json::array();
    methods.push_back(status);
    return methods;
  }

  void setEventListenerStd(UniversalEventCallback cb) override { m_emit = cb; }

 private:
  UniversalEventCallback m_emit;
};

LogosAPI* g_api = nullptr;
EchoProvider* g_provider = nullptr;
std::atomic<bool> g_loop_running{false};

Napi::Value Publish(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    throw Napi::TypeError::New(env, "publish(port, mode)");
  }
  const uint16_t port = static_cast<uint16_t>(info[0].As<Napi::Number>().Uint32Value());
  const std::string mode = info[1].As<Napi::String>().Utf8Value();

  EnsureQtApp();

  LogosTransportConfig tcp;
  tcp.protocol = LogosProtocol::Tcp;
  tcp.host = "127.0.0.1";
  tcp.port = port;
  tcp.codec = LogosWireCodec::Json;

  LogosTransportSet transports{tcp};

  // THE INBOUND TOKEN. daemon.cpp does exactly this (step 8): a caller must
  // PRESENT a token that this process has registered as acceptable, and
  // saveInboundToken — not saveToken — is the direction that files it as "what
  // a caller sends me" rather than "what I send that caller".
  //
  // Without it the ModuleProxy has no credential to match, and the observed
  // failure is a HANG, not a refusal — the same shape as every other missing-
  // token failure in this tree, and the reason they were misread as transport
  // limitations.
  const std::string token = info.Length() > 2 && info[2].IsString()
                                ? info[2].As<Napi::String>().Utf8Value()
                                : std::string();
  if (!token.empty()) {
    // Two identities, matching what logosctl's client does on its side
    // (client.cpp:126-127 saves under BOTH "cli_client" and "core_service").
    const bool a = TokenManager::instance().saveInboundToken(
        std::string("exp_client"), token);
    const bool b = TokenManager::instance().saveInboundToken(
        std::string("exp_service"), token);
    std::fprintf(stderr, "[exp] saveInboundToken exp_client=%d exp_service=%d\n", a, b);
  }

  // Exactly daemon.cpp:571's three lines.
  g_api = new LogosAPI("exp_service", transports);
  g_provider = new EchoProvider();
  g_provider->init(g_api);
  LogosAPIProvider* provider = g_api->getProvider();
  if (provider == nullptr) {
    throw Napi::Error::New(env, "getProvider() returned null");
  }

  // The daemon's escape hatch for tokens its built-in scan does not know
  // (daemon.cpp, just before registerObject). Accepting anything here turns
  // "is authorization the blocker?" into a yes/no answer rather than a guess.
  if (std::getenv("EXP_ACCEPT_ANY_TOKEN") != nullptr) {
    provider->setTokenValidator([](const QString& t, const QString& proto) {
      std::fprintf(stderr, "[exp] tokenValidator(token=%s, proto=%s) -> accept\n",
                   t.toUtf8().constData(), proto.toUtf8().constData());
      return true;
    });
  }

  const bool ok =
      provider->registerObject(QStringLiteral("exp_service"),
                               static_cast<LogosProviderObject*>(g_provider));

  std::fprintf(stderr, "[exp] registerObject -> %s, registryUrl=%s, mode=%s\n",
               ok ? "true" : "false",
               provider->registryUrl().toUtf8().constData(), mode.c_str());

  if (mode == "thread") {
    // A dedicated Qt thread running its own QEventLoop. NOTE: the QTcpServer
    // was created on THIS (JS) thread, so its socket notifiers are affined
    // here; whether a foreign loop services them at all is one of the things
    // this measures.
    g_loop_running = true;
    std::thread([]() {
      QEventLoop loop;
      loop.exec();
    }).detach();
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("registered", Napi::Boolean::New(env, ok));
  out.Set("registryUrl",
          Napi::String::New(env, provider->registryUrl().toStdString()));
  return out;
}

// One processEvents() pass. Driven from a JS setInterval, this is the
// "cooperative pumping" option: no nested Qt loop, so Chromium keeps its own
// loop and Qt only ever runs between JS turns.
Napi::Value Tick(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  QCoreApplication* app = QCoreApplication::instance();
  if (app == nullptr) return Napi::Number::New(env, -1);
  // AllEvents, and a small time budget: enough to drain a burst of socket
  // activity, bounded so the JS thread is never held for long.
  QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
  QCoreApplication::sendPostedEvents();
  return Napi::Number::New(env, 0);
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  exports.Set("publish", Napi::Function::New(env, Publish));
  exports.Set("tick", Napi::Function::New(env, Tick));
  return exports;
}

}  // namespace

NODE_API_MODULE(exp_provider, InitAddon)
