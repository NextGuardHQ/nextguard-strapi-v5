'use strict';

/**
 * Security-focused tests for the Strapi 5 NextGuard plugin service.
 * Runner: node --test  (node:test + node:assert/strict)
 *
 * The TypeScript source is compiled to a temp dir at startup via tsc.
 * No Jest / ts-jest required — pure Node.js stdlib.
 */

const test      = require('node:test');
const assert    = require('node:assert/strict');
const crypto    = require('node:crypto');
const http      = require('node:http');
const fs        = require('node:fs');
const os        = require('node:os');
const path      = require('node:path');
const { execSync } = require('node:child_process');

// ── Compile TS service to CommonJS at startup ─────────────────────────────────

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SERVICE_SRC  = path.join(PLUGIN_ROOT, 'server', 'services', 'nextguard.ts');
const DIST_DIR     = path.join(os.tmpdir(), 'ng-strapi5-test-dist');

// Locate tsc — prefer local opencode tsc, fall back to PATH
const TSC_CANDIDATES = [
  '/home/camisi/.local/share/opencode/bin/node_modules/.bin/tsc',
  'tsc',
];
let tsc = null;
for (const candidate of TSC_CANDIDATES) {
  try { execSync(`"${candidate}" --version`, { stdio: 'ignore' }); tsc = candidate; break; } catch {}
}
if (!tsc) throw new Error('tsc not found — install TypeScript to run Strapi 5 tests');

// Compile — type errors on @strapi/strapi import are expected and harmless;
// tsc still emits JS even when it exits with status 2.
// We use spawnSync so we can ignore a non-zero exit code.
const { spawnSync } = require('node:child_process');
const tscResult = spawnSync(tsc, [
  '--skipLibCheck',
  '--target', 'ES2020',
  '--module', 'CommonJS',
  '--moduleResolution', 'node',
  '--esModuleInterop',
  '--outDir', DIST_DIR,
  '--rootDir', PLUGIN_ROOT,
  SERVICE_SRC,
], { cwd: PLUGIN_ROOT, encoding: 'utf8' });

const compiledPath = path.join(DIST_DIR, 'server', 'services', 'nextguard.js');
if (!fs.existsSync(compiledPath)) {
  throw new Error(
    `tsc failed to emit JS.\nstdout: ${tscResult.stdout}\nstderr: ${tscResult.stderr}`
  );
}

const serviceFactory = require(path.join(DIST_DIR, 'server', 'services', 'nextguard.js')).default;

// ── In-process HTTP capture server ───────────────────────────────────────────

function createCaptureServer(responseBody = { success: true }, statusCode = 200) {
  const captured = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({
        method  : req.method,
        url     : req.url,
        headers : req.headers,
        rawBody : raw,
        body    : raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null,
      });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        captured,
        url   : `http://127.0.0.1:${port}`,
        close() { server.close(); },
      });
    });
  });
}

// ── Strapi stub factory ───────────────────────────────────────────────────────

function makeStrapi(storeValues = {}, dirs = null, pkg = null) {
  const store = { ...storeValues };

  const pluginStore = {
    get: async ({ key }) => store[key] ?? null,
    set: async ({ key, value }) => { store[key] = value; },
  };

  const appRoot = dirs?.app?.root || os.tmpdir();

  if (pkg) {
    const pkgPath = path.join(appRoot, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  }

  return {
    store: () => pluginStore,
    dirs : dirs ?? { app: { root: appRoot } },
    log  : { warn: () => {} },
    config: { get: () => '' },
    _store: store,
  };
}

// ── Helper: recompile with patched HOST env and re-require ────────────────────

function requireWithHost(host) {
  // tsc output is already compiled; re-require with patched NEXTGUARD_HOST
  // by clearing the module cache and re-requiring with the env var set.
  const compiledPath = path.join(DIST_DIR, 'server', 'services', 'nextguard.js');
  delete require.cache[compiledPath];
  const origHost = process.env.NEXTGUARD_HOST;
  process.env.NEXTGUARD_HOST = host;
  const mod = require(compiledPath).default;
  process.env.NEXTGUARD_HOST = origHost;
  return mod;
}

// ── 1. HMAC signing ───────────────────────────────────────────────────────────

test('HMAC reference impl: sha256= prefix + 64-char lowercase hex', () => {
  const token    = 'reference-key';
  const method   = 'POST';
  const urlPath  = '/api/v1/cms/sync';
  const bodyStr  = JSON.stringify({ projectId: 'p1', cmsType: 'strapi' });

  const timestamp  = Math.floor(Date.now() / 1000);
  const bodyHash   = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const sigPayload = `${timestamp}\n${method.toUpperCase()}\n${urlPath}\n${bodyHash}`;
  const sig        = 'sha256=' + crypto.createHmac('sha256', token).update(sigPayload).digest('hex');

  assert.ok(sig.startsWith('sha256='));
  assert.equal(sig.slice(7).length, 64);
  assert.ok(/^[0-9a-f]+$/.test(sig.slice(7)));
});

test('HMAC signature is deterministic given fixed inputs', () => {
  const token   = 'determinism-key';
  const ts      = 1700000000;
  const urlPath = '/api/v1/cms/sync';
  const body    = '{"projectId":"p"}';

  function sign() {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const pay  = `${ts}\nPOST\n${urlPath}\n${hash}`;
    return 'sha256=' + crypto.createHmac('sha256', token).update(pay).digest('hex');
  }

  assert.equal(sign(), sign(), 'same inputs must produce same signature');
});

test('HMAC signature changes when body changes', () => {
  const ts = 1700000000; const token = 'k'; const urlPath = '/p';
  function sign(body) {
    const h = crypto.createHash('sha256').update(body).digest('hex');
    const p = `${ts}\nPOST\n${urlPath}\n${h}`;
    return 'sha256=' + crypto.createHmac('sha256', token).update(p).digest('hex');
  }
  assert.notEqual(sign('body-A'), sign('body-B'));
});

test('HMAC signature changes when token changes', () => {
  const ts = 1700000000; const urlPath = '/p'; const body = 'same';
  function sign(token) {
    const h = crypto.createHash('sha256').update(body).digest('hex');
    const p = `${ts}\nPOST\n${urlPath}\n${h}`;
    return 'sha256=' + crypto.createHmac('sha256', token).update(p).digest('hex');
  }
  assert.notEqual(sign('key-1'), sign('key-2'));
});

test('HMAC signature changes when urlPath changes', () => {
  const ts = 1700000000; const token = 'k'; const body = 'same';
  function sign(urlPath) {
    const h = crypto.createHash('sha256').update(body).digest('hex');
    const p = `${ts}\nPOST\n${urlPath}\n${h}`;
    return 'sha256=' + crypto.createHmac('sha256', token).update(p).digest('hex');
  }
  assert.notEqual(sign('/api/v1/cms/sync'), sign('/api/v1/files/upload'));
});

test('sync() sends X-NG-Signature with sha256= prefix', async () => {
  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: os.tmpdir() } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const sig = mock.captured[0].headers['x-ng-signature'];
  assert.ok(sig, 'X-NG-Signature must be present');
  assert.ok(sig.startsWith('sha256='), `sig must start with sha256=, got: ${sig}`);
});

test('sync() X-NG-Signature matches manual recompute', async () => {
  const token  = 'recompute-test-key';
  const mock   = await createCaptureServer({ success: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-recomp-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ dependencies: {} }));

  const strapi = makeStrapi({ token, projectId: 'proj-rc' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const req      = mock.captured[0];
  const ts       = req.headers['x-ng-timestamp'];
  const sentSig  = req.headers['x-ng-signature'];
  const bodyHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const payload  = `${ts}\nPOST\n/api/v1/cms/sync\n${bodyHash}`;
  const expected = 'sha256=' + crypto.createHmac('sha256', token).update(payload).digest('hex');

  assert.equal(sentSig, expected, 'X-NG-Signature must match manual recompute');
});

// ── 2. Token priority ─────────────────────────────────────────────────────────

test('requestActivationCode sends X-API-Key header', async () => {
  const mock   = await createCaptureServer({ code: 'TS12', expiresIn: 900 });
  const strapi = makeStrapi({});
  const svc    = requireWithHost(mock.url)({ strapi });

  const result = await svc.requestActivationCode('vs_pk_tskey');
  mock.close();

  assert.equal(mock.captured[0].headers['x-api-key'], 'vs_pk_tskey');
  assert.equal(result.code, 'TS12');
});

test('sync() uses token from store as X-API-Key', async () => {
  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'stored-device-token', projectId: 'p' }, { app: { root: os.tmpdir() } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  assert.equal(mock.captured[0].headers['x-api-key'], 'stored-device-token');
});

// ── 3. sync() / syncIfConfigured() guard logic ───────────────────────────────

test('sync() throws when token is missing', async () => {
  const strapi = makeStrapi({ projectId: 'p', token: null });
  const svc    = serviceFactory({ strapi });

  await assert.rejects(
    () => svc.sync(),
    (err) => {
      assert.ok(err.message.includes('not configured'));
      return true;
    }
  );
});

test('sync() throws when projectId is missing', async () => {
  const strapi = makeStrapi({ token: 'tok', projectId: null });
  const svc    = serviceFactory({ strapi });

  await assert.rejects(
    () => svc.sync(),
    (err) => { assert.ok(err.message.includes('not configured')); return true; }
  );
});

test('syncIfConfigured() skips sync when not configured', async () => {
  const strapi = makeStrapi({ token: null, projectId: null });
  const svc    = serviceFactory({ strapi });
  let syncCalled = false;
  svc.sync = async () => { syncCalled = true; };

  await svc.syncIfConfigured();
  assert.equal(syncCalled, false);
});

test('syncIfConfigured() swallows errors', async () => {
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' });
  const svc    = serviceFactory({ strapi });
  svc.sync = async () => { throw new Error('network error'); };

  await svc.syncIfConfigured(); // must not throw
});

// ── 4. Plugin detection ───────────────────────────────────────────────────────

test('detectPackages finds @strapi/* packages', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-det-'));
  const pkg = {
    dependencies: {
      '@strapi/strapi'           : '^5.0.0',
      '@strapi/plugin-seo'       : '^5.0.0',
      '@strapi/provider-email-sendgrid': '^5.0.0',
    },
  };
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify(pkg));

  for (const name of Object.keys(pkg.dependencies)) {
    const modDir = path.join(tmpRoot, 'node_modules', name);
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ version: '5.0.0' }));
  }

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const components = mock.captured[0].body.components;
  assert.ok(components.length >= 3, `expected >= 3 components, got ${components.length}`);
  assert.ok(components.some((c) => c.type === 'core'),     'core must be detected');
  assert.ok(components.some((c) => c.type === 'plugin'),   'plugin must be detected');
  assert.ok(components.some((c) => c.type === 'provider'), 'provider must be detected');
});

test('detectPackages finds strapi-plugin-* community packages', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-comm-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({
    dependencies: { '@strapi/strapi': '^5.0.0', 'strapi-plugin-tinymce': '^2.0.0' },
  }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  assert.ok(mock.captured[0].body.components.some((c) => c.name === 'strapi-plugin-tinymce'));
});

test('detectPackages ignores non-strapi packages', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-ign-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({
    dependencies: { '@strapi/strapi': '^5.0.0', 'express': '^4.18.0', 'lodash': '^4.0.0' },
  }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const names = mock.captured[0].body.components.map((c) => c.name);
  assert.ok(!names.includes('express'), 'express must not appear');
  assert.ok(!names.includes('lodash'),  'lodash must not appear');
});

// ── 5. Config store get/set ───────────────────────────────────────────────────

test('getConfig returns stored values', async () => {
  const strapi = makeStrapi({ projectId: 'proj-ts5', token: 'tok-ts5', projectName: 'TS Site', lastSync: null });
  const svc    = serviceFactory({ strapi });

  const cfg = await svc.getConfig();
  assert.equal(cfg.projectId,   'proj-ts5');
  assert.equal(cfg.token,       'tok-ts5');
  assert.equal(cfg.projectName, 'TS Site');
});

test('saveConfig writes only provided fields', async () => {
  const strapi = makeStrapi({ projectId: 'old', token: 'old-tok', projectName: 'Old' });
  const svc    = serviceFactory({ strapi });

  await svc.saveConfig({ projectId: 'new' });
  const cfg = await svc.getConfig();

  assert.equal(cfg.projectId,   'new');
  assert.equal(cfg.token,       'old-tok', 'token must be preserved');
  assert.equal(cfg.projectName, 'Old',     'projectName must be preserved');
});

test('disconnect nullifies all config keys', async () => {
  const strapi = makeStrapi({ projectId: 'p', token: 'tok', projectName: 'N', lastSync: 'T' });
  const svc    = serviceFactory({ strapi });

  await svc.disconnect();
  const cfg = await svc.getConfig();

  assert.equal(cfg.projectId,   null);
  assert.equal(cfg.token,       null);
  assert.equal(cfg.projectName, null);
  assert.equal(cfg.lastSync,    null);
});

// ── 6. pollActivationStatus ───────────────────────────────────────────────────

test('pollActivationStatus returns { status: "pending" } on 202', async () => {
  const mock   = await createCaptureServer({ status: 'pending' }, 202);
  const strapi = makeStrapi({});
  const svc    = requireWithHost(mock.url)({ strapi });

  const result = await svc.pollActivationStatus('MY-CODE', 'api-key');
  mock.close();

  assert.equal(result.status, 'pending');
});

test('pollActivationStatus returns authorized body on 200', async () => {
  const mock   = await createCaptureServer({
    status: 'authorized', token: 'dev-tok', projectId: 'p1', projectName: 'Site',
  }, 200);
  const strapi = makeStrapi({});
  const svc    = requireWithHost(mock.url)({ strapi });

  const result = await svc.pollActivationStatus('CODE', 'api-key');
  mock.close();

  assert.equal(result.status, 'authorized');
  assert.equal(result.token,  'dev-tok');
});

// ── 7. Sync payload and security ─────────────────────────────────────────────

test('sync() payload contains projectId and cmsType=strapi', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-pay-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ dependencies: {} }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'target-project' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const body = mock.captured[0].body;
  assert.equal(body.projectId, 'target-project');
  assert.equal(body.cmsType,   'strapi');
});

test('sync() X-NG-Timestamp is within 5 s of current time', async () => {
  const before  = Math.floor(Date.now() / 1000);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-ts-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ dependencies: {} }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  const after = Math.floor(Date.now() / 1000);
  const ts    = parseInt(mock.captured[0].headers['x-ng-timestamp'], 10);
  assert.ok(ts >= before && ts <= after + 1, `timestamp ${ts} not in [${before}, ${after + 1}]`);
});

test('sync() API key not leaked in URL path', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-url-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ dependencies: {} }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'super-secret-ts5-token', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  assert.ok(!mock.captured[0].url.includes('super-secret-ts5-token'), 'token must not appear in URL');
});

test('sync() updates lastSync on 200', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-s5-ls-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ dependencies: {} }));

  const mock   = await createCaptureServer({ success: true });
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' }, { app: { root: tmpRoot } });
  const svc    = requireWithHost(mock.url)({ strapi });

  await svc.sync();
  mock.close();

  assert.ok(strapi._store.lastSync, 'lastSync must be written after successful sync');
  assert.ok(!isNaN(Date.parse(strapi._store.lastSync)), 'lastSync must be ISO date');
});

// ── 8. Error handling ─────────────────────────────────────────────────────────

test('requestActivationCode throws on 401', async () => {
  const mock   = await createCaptureServer({ error: 'Unauthorized' }, 401);
  const strapi = makeStrapi({});
  const svc    = requireWithHost(mock.url)({ strapi });

  await assert.rejects(
    () => svc.requestActivationCode('bad-key'),
    (err) => { assert.ok(err instanceof Error); return true; }
  );
  mock.close();
});

test('syncIfConfigured() swallows ECONNREFUSED', async () => {
  const strapi = makeStrapi({ token: 'tok', projectId: 'p' });
  const svc    = requireWithHost('http://127.0.0.1:1')({ strapi });

  await svc.syncIfConfigured(); // must not throw
});
