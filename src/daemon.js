// The logosctl daemon, as a child process of the Electron app.
//
// WHY A DAEMON AT ALL. 0.1.0 loads delivery_module through liblogos_core's C
// ABI but cannot CALL it: a Qt-free consumer reaching a Qt module directly over
// a plain transport hangs forever, because capability_module publishes nothing
// there for the token handshake to land on. NEXT.md has the full post-mortem.
//
// The route that works is the one logosctl itself takes — talk to `core_service`,
// a gateway registered in-process by the daemon, which proxies every module call
// through a real C++ TokenManager. So the app runs that daemon beside itself and
// speaks to the gateway over loopback TCP.
//
// Everything here was learned by running it; see the comments on each step.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');

// core_service and capability_module each need their OWN port: two QTcpServers
// cannot share an address:port, and a client dials capability_module separately
// for a per-target token.
const CORE_PORT = Number(process.env.LOGOS_CORE_PORT || 7001);
const CAP_PORT = Number(process.env.LOGOS_CAP_PORT || 7002);

// Modules the daemon must have in its own store before delivery_module can load.
// capability_module is NOT here: the daemon ships its own copy, and installing a
// second one over it is unnecessary. Order matters only in that lgpm resolves
// each package independently; `module load` pulls the dependency chain itself.
const DAEMON_PACKAGES = ['lez-core-lgx', 'lez-rln-lgx', 'rln-lgx', 'delivery-lgx'];

// TCP ONLY, and deliberately so.
//
// Listing `local` and `tcp` together passes the daemon's own config validator
// and then the daemon dies silently mid-startup — its log stops after
// capability_module with no ports, no socket and no error. TCP alone binds both
// ports and stays up. The cost is that logosctl's own CLI client (which dials
// the local endpoint) reports NO_DAEMON against this config; irrelevant here,
// since the app is the only client and it speaks TCP.
//
// insecure_tcp is required for plaintext listeners — the daemon refuses them
// otherwise. 127.0.0.1 only, so no token ever leaves the machine.
function daemonConfig() {
  return [
    'insecure_tcp: true',
    'modules:',
    '  core_service:',
    '    - protocol: tcp',
    '      host: 127.0.0.1',
    `      port: ${CORE_PORT}`,
    '      codec: json',
    '  capability_module:',
    '    - protocol: tcp',
    '      host: 127.0.0.1',
    `      port: ${CAP_PORT}`,
    '      codec: json',
    '',
  ].join('\n');
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Daemon {
  /**
   * @param {object} opts
   * @param {string} opts.binary    path to the logosctl executable
   * @param {string} opts.configDir session directory (its own, not the user's)
   * @param {string} opts.packageDir where the .lgx packages live
   * @param {(line: string) => void} opts.log
   */
  constructor({ binary, configDir, packageDir, log }) {
    this.binary = binary;
    this.configDir = configDir;
    this.packageDir = packageDir;
    this.log = log || (() => {});
    this.started = false;
  }

  // logosctl finds its whole session — config, module store, keyring, tokens —
  // through this one variable. Pointing it at a directory under the app's
  // userData keeps the PoC from colliding with a logosctl the user runs by hand,
  // and makes the daemon's state disappear with the app's.
  env() {
    return { ...process.env, LOGOSCTL_CONFIG_DIR: this.configDir };
  }

  run(args, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve) => {
      execFile(
        this.binary,
        args,
        { env: this.env(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
      );
    });
  }

  /** Bring the daemon up and load `moduleName` in it. Idempotent-ish: a daemon
   *  left over from a previous run is stopped first, because `daemon start`
   *  refuses a second daemon in the same session dir and a stale one holds an
   *  already-rotated token. */
  async start(moduleName) {
    fs.mkdirSync(this.configDir, { recursive: true });

    this.log('stopping any daemon left from a previous run');
    await this.run(['daemon', 'stop'], { timeoutMs: 20000 });

    const configPath = path.join(this.configDir, 'daemon-node.yaml');
    fs.writeFileSync(configPath, daemonConfig());
    const set = await this.run(['daemon', 'config', 'set', configPath]);
    if (!set.ok) {
      throw new Error(`daemon config set failed: ${(set.stderr || set.stdout).trim()}`);
    }
    this.log(`daemon config installed (core_service :${CORE_PORT}, capability :${CAP_PORT})`);

    // --detach, NOT a bare `daemon start`.
    //
    // `logosctl daemon start` does not detach when stdout is not a TTY: it holds
    // the foreground writing the daemon's log and never returns, so spawning it
    // and awaiting exit hangs forever. --detach forks and returns as soon as the
    // daemon accepts commands — verified to return in well under a second with a
    // piped stdout, which is exactly the case here.
    this.log('starting daemon…');
    const started = await this.run(['daemon', 'start', '--detach'], { timeoutMs: 120000 });
    if (!started.ok) {
      throw new Error(`daemon start failed: ${(started.stderr || started.stdout).trim()}`);
    }
    for (const line of started.stdout.split('\n')) {
      if (line.trim()) this.log(line.trim());
    }

    // --detach returning means "accepting commands", which is not quite the same
    // as "the TCP listeners are bound". Poll for the thing the SDK actually
    // needs, rather than trusting the handshake to imply it.
    let bound = false;
    for (let i = 0; i < 60 && !bound; i += 1) {
      bound = (await canConnect(CORE_PORT)) && (await canConnect(CAP_PORT));
      if (!bound) await delay(500);
    }
    if (!bound) {
      throw new Error(
        `daemon did not bind 127.0.0.1:${CORE_PORT}/${CAP_PORT}; see ${path.join(this.configDir, 'logs')}`
      );
    }
    this.started = true;
    this.log(`core_service listening on 127.0.0.1:${CORE_PORT}`);

    await this.installPackages();

    // Load through the CLI rather than core_service.loadModule: this is a single
    // blocking call whose failure text is worth reading verbatim, and it pulls
    // in lez_core, liblogos_lez_rln_module and liblogos_rln_module by itself.
    this.log(`loading ${moduleName}…`);
    const loaded = await this.run(['module', 'load', moduleName], { timeoutMs: 180000 });
    const reply = (loaded.stdout || loaded.stderr).trim();
    if (!loaded.ok) throw new Error(`module load ${moduleName} failed: ${reply}`);
    this.log(reply.slice(0, 300));

    return { corePort: CORE_PORT, capPort: CAP_PORT };
  }

  async installPackages() {
    if (!fs.existsSync(this.packageDir)) {
      this.log(`no package dir at ${this.packageDir}; assuming the store is already populated`);
      return;
    }
    for (const name of DAEMON_PACKAGES) {
      const dir = path.join(this.packageDir, name);
      if (!fs.existsSync(dir)) continue;
      const lgx = fs.readdirSync(dir).filter((f) => f.endsWith('.lgx'));
      if (lgx.length === 0) continue;
      // Failure is tolerated and not logged as an error: a package already
      // installed at the same version is reported as one, and re-running the
      // app is the normal case.
      const res = await this.run(
        ['package', 'install', '--file', path.join(dir, lgx[0]), '-y'],
        { timeoutMs: 120000 }
      );
      this.log(`  ${name}: ${res.ok ? 'installed' : 'already present'}`);
    }
  }

  /** The token the daemon issued for its own clients.
   *
   *  READ THIS AFTER THE DAEMON HAS BOOTED, never from a value cached earlier:
   *  auto.json is rewritten on EVERY daemon boot, and a stale token does not
   *  produce an auth error — the call simply never answers, which is
   *  indistinguishable from a transport hang and cost an afternoon of
   *  misdiagnosis the first time. */
  token() {
    for (const file of [
      path.join(this.configDir, 'client', 'auto.json'),
      path.join(os.homedir(), '.logosctl', 'client', 'auto.json'),
    ]) {
      try {
        const token = JSON.parse(fs.readFileSync(file, 'utf8')).token;
        if (token) return token;
      } catch {
        // Next candidate.
      }
    }
    return null;
  }

  /** Bring the daemon down. Best-effort and synchronous-ish: this runs from
   *  Electron's quit path, where an unresolved promise is simply not awaited, so
   *  a spawned stop that outlives us is better than a hang. */
  stop() {
    if (!this.started) return;
    this.started = false;
    try {
      const child = spawn(this.binary, ['daemon', 'stop'], {
        env: this.env(),
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      // Going away regardless.
    }
  }
}

module.exports = { Daemon, CORE_PORT, CAP_PORT };
