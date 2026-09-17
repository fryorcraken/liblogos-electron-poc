{
  # Build config for the liblogos N-API addon.
  #
  # Two things have to be discovered at build time and they come from different
  # places: liblogos itself from LOGOS_LIBLOGOS_ROOT (a `nix build` result dir
  # with include/ lib/ bin/), and Qt6Core from pkg-config. Both are resolved by
  # scripts/gyp-config.js, which gyp runs through <!@() below, because gyp
  # cannot call pkg-config or read the environment on its own.
  #
  # rpath is recorded on the .node itself: an Electron app is launched by the
  # electron binary, so there is no wrapper script in a position to set
  # LD_LIBRARY_PATH, and the addon must be able to find liblogos_core and Qt
  # on its own once dlopen'd.
  "targets": [
    {
      # NOT "liblogos": the toolchain strips a leading "lib" from the module
      # name, which would silently produce logos.node and break the require()
      # path in src/index.js. Named to survive that.
      "target_name": "logos_addon",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
        "<!@(node scripts/gyp-config.js include_dirs)"
      ],
      "libraries": [
        "<!@(node scripts/gyp-config.js libraries)"
      ],
      "cflags_cc": [
        "<!@(node scripts/gyp-config.js cflags_cc)"
      ],
      # NAPI_CPP_EXCEPTION_ALL lets node-addon-api translate C++ exceptions
      # into JS exceptions; liblogos is C++ underneath and Qt can throw.
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc+": ["-std=c++17"]
    }
  ]
}
