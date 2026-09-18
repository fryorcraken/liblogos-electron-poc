{
  # EXPERIMENT build. Separate from the repo's binding.gyp on purpose: the
  # shipped addon links only liblogos_core + Qt6Core, and nothing here is
  # allowed to change that.
  #
  # Extra link inputs over the shipped addon:
  #   -llogos_qt_host    LogosAPI, LogosAPIProvider   (logos-liblogos)
  #   -llogos_protocol   LogosProviderObject bridges, TokenManager,
  #                      LogosAPIClient                (logos-protocol)
  #   nlohmann/json.hpp  the universal dispatch's arg/return type
  "targets": [
    {
      "target_name": "exp_provider",
      "sources": ["exp_addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
        "<!@(node ../gyp-config.js include_dirs)",
        "<!@(node exp-config.js nlohmann_include)"
      ],
      "libraries": [
        "<!@(node ../gyp-config.js libraries)",
        "<!@(node exp-config.js extra_libraries)"
      ],
      "cflags_cc": [
        "<!@(node ../gyp-config.js cflags_cc)"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc+": ["-std=c++17"]
    },
    {
      # EXPERIMENT 2: the in-process CALL path (no published gateway at all).
      "target_name": "exp_call",
      "sources": ["exp_call.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
        "<!@(node ../gyp-config.js include_dirs)",
        "<!@(node exp-config.js nlohmann_include)"
      ],
      "libraries": [
        "<!@(node ../gyp-config.js libraries)",
        "<!@(node exp-config.js extra_libraries)"
      ],
      "cflags_cc": [
        "<!@(node ../gyp-config.js cflags_cc)"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc+": ["-std=c++17"]
    },
    {
      # EXPERIMENT 3: event subscription — the inventory item with no evidence.
      "target_name": "exp_event",
      "sources": ["exp_event.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
        "<!@(node ../gyp-config.js include_dirs)",
        "<!@(node exp-config.js nlohmann_include)"
      ],
      "libraries": [
        "<!@(node ../gyp-config.js libraries)",
        "<!@(node exp-config.js extra_libraries)"
      ],
      "cflags_cc": [
        "<!@(node ../gyp-config.js cflags_cc)"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc+": ["-std=c++17"]
    }
  ]
}
