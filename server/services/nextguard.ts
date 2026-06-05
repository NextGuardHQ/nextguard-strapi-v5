import crypto from 'node:crypto';
import https  from 'node:https';
import http   from 'node:http';
import path   from 'node:path';
import fs     from 'node:fs';
import type { Core } from '@strapi/strapi';

const HOST          = process.env.NEXTGUARD_HOST ?? 'https://nextguardhq.com';
const SYNC_PATH     = '/api/v1/cms/sync';
const ACTIVATE_PATH = '/api/v1/auth/activate';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface HttpResponse { status: number; body: any; }

function request(
  method : string,
  urlStr : string,
  headers: Record<string, string>,
  bodyStr: string | null
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const lib     = url.protocol === 'https:' ? https : http;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;

    const req = lib.request(
      {
        hostname: url.hostname,
        port    : Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        path    : url.pathname + url.search,
        method,
        headers : {
          'Content-Type': 'application/json',
          ...headers,
          ...(bodyBuf ? { 'Content-Length': String(bodyBuf.length) } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('NextGuard request timeout')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── HMAC-SHA256 signing ──────────────────────────────────────────────────────

function buildHeaders(method: string, urlPath: string, bodyStr: string, token: string) {
  const timestamp  = Math.floor(Date.now() / 1000);
  const bodyHash   = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const sigPayload = `${timestamp}\n${method.toUpperCase()}\n${urlPath}\n${bodyHash}`;
  return {
    'X-API-Key'     : token,
    'X-NG-Timestamp': String(timestamp),
    'X-NG-Signature': 'sha256=' + crypto.createHmac('sha256', token).update(sigPayload).digest('hex'),
  };
}

// ─── Package detection ────────────────────────────────────────────────────────

function installedVersion(appRoot: string, pkgName: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'node_modules', pkgName, 'package.json'), 'utf8');
    return JSON.parse(raw).version as string;
  } catch { return null; }
}

function detectPackages(strapiInstance: Core.Strapi) {
  const appRoot = (strapiInstance as any).dirs?.app?.root ?? process.cwd();
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch { return []; }

  const components: Array<{
    name: string; slug: string; version: string; type: string; active: boolean;
  }> = [];

  for (const [name, specifier] of Object.entries(deps)) {
    if (!name.startsWith('@strapi/') && !name.startsWith('strapi-plugin-') && name !== 'strapi') continue;

    let type = 'module';
    if (name === '@strapi/strapi' || name === 'strapi')            type = 'core';
    else if (name.startsWith('@strapi/plugin-') || name.startsWith('strapi-plugin-')) type = 'plugin';
    else if (name.startsWith('@strapi/provider-'))                  type = 'provider';

    components.push({
      name,
      slug   : name,
      version: installedVersion(appRoot, name) ?? (specifier as string).replace(/^[^0-9]*/, ''),
      type,
      active : true,
    });
  }

  return components;
}

// ─── Store helper ─────────────────────────────────────────────────────────────

const pluginStore = (s: Core.Strapi) => s.store({ type: 'plugin', name: 'nextguard' });
const storeGet    = async (s: Core.Strapi, key: string) =>
  (await pluginStore(s)).get({ key }) as string | null;
const storeSet    = async (s: Core.Strapi, key: string, value: string | null) =>
  (await pluginStore(s)).set({ key, value });

// ─── Service ─────────────────────────────────────────────────────────────────

const nextguardService = ({ strapi }: { strapi: Core.Strapi }) => ({

  async getConfig() {
    return {
      projectId  : await storeGet(strapi, 'projectId'),
      projectName: await storeGet(strapi, 'projectName'),
      token      : await storeGet(strapi, 'token'),
      lastSync   : await storeGet(strapi, 'lastSync'),
    };
  },

  async saveConfig({ projectId, projectName, token }: {
    projectId?: string | null;
    projectName?: string | null;
    token?: string | null;
  }) {
    if (projectId   !== undefined) await storeSet(strapi, 'projectId',   projectId);
    if (projectName !== undefined) await storeSet(strapi, 'projectName', projectName);
    if (token       !== undefined) await storeSet(strapi, 'token',       token);
  },

  async disconnect() {
    for (const key of ['projectId', 'projectName', 'token', 'lastSync']) {
      await storeSet(strapi, key, null);
    }
  },

  async requestActivationCode(apiKey: string) {
    const res = await request('POST', `${HOST}${ACTIVATE_PATH}`, { 'X-API-Key': apiKey }, '{}');
    if (res.status !== 200) throw new Error(res.body?.error ?? 'Could not request activation code');
    return res.body as { code: string; expiresIn: number };
  },

  async pollActivationStatus(code: string, apiKey: string) {
    const res = await request(
      'GET',
      `${HOST}${ACTIVATE_PATH}?code=${encodeURIComponent(code)}`,
      { 'X-API-Key': apiKey },
      null
    );
    if (res.status === 200) return res.body as { status: 'authorized'; token: string; projectId: string; projectName: string };
    if (res.status === 202) return { status: 'pending' as const };
    throw new Error(res.body?.error ?? 'Poll failed');
  },

  async sync() {
    const cfg = await this.getConfig();
    if (!cfg.token || !cfg.projectId) throw new Error('NextGuard: not configured');

    const appRoot = (strapi as any).dirs?.app?.root ?? process.cwd();
    const payload = {
      projectId  : cfg.projectId,
      cmsType    : 'strapi',
      cmsVersion : installedVersion(appRoot, '@strapi/strapi') ?? installedVersion(appRoot, 'strapi') ?? 'unknown',
      nodeVersion: process.version.replace('v', ''),
      siteUrl    : (strapi.config as any).get?.('server.url', '') ?? '',
      components : detectPackages(strapi),
    };

    const bodyStr = JSON.stringify(payload);
    const headers = buildHeaders('POST', SYNC_PATH, bodyStr, cfg.token);
    const res     = await request('POST', `${HOST}${SYNC_PATH}`, headers, bodyStr);

    if (res.status === 200) {
      await storeSet(strapi, 'lastSync', new Date().toISOString());
    }

    return { success: res.status === 200, components: payload.components.length };
  },

  async syncIfConfigured() {
    try {
      const cfg = await this.getConfig();
      if (cfg.token && cfg.projectId) await this.sync();
    } catch (err: any) {
      strapi.log.warn('[nextguard] Sync failed:', err.message);
    }
  },
});

export default nextguardService;
