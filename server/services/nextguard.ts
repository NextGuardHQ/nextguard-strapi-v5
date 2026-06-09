import crypto from 'node:crypto';
import https  from 'node:https';
import http   from 'node:http';
import path   from 'node:path';
import fs     from 'node:fs';
import type { Core } from '@strapi/strapi';

const HOST          = process.env.NEXTGUARD_HOST ?? 'https://nextguardhq.com';
const SYNC_PATH     = '/api/v1/cms/sync';
const ACTIVATE_PATH = '/api/v1/auth/activate';
const PLANS_PATH    = '/api/public/plans';

// ─── Public types ───────────────────────────────────────────────────────────

export interface Plan {
  key         : string;
  name        : string;
  priceDisplay: string;
  period      : string;
  cta         : string;
  highlighted : boolean;
  features    : string[];
  href        : string;
}

export interface PreviewVuln {
  severity        : string;
  componentName   : string;
  installedVersion: string;
  title           : string;
  fixedIn         : string;
  cveId           : string;
}

export interface PreviewSummary {
  total   : number;
  critical: number;
  high    : number;
  medium  : number;
  low     : number;
}

export interface Preview {
  available: boolean;
  summary  : PreviewSummary;
  shown    : PreviewVuln[];
  hidden   : number;
}

// Anonymous Live Scan keys bind to an ephemeral project server-side, so they
// skip the device-authorization flow and sync immediately.
const isAnonKey = (key: string) => key.startsWith('vs_pk_anon_');

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
      apiKey     : await storeGet(strapi, 'apiKey'),
      lastSync   : await storeGet(strapi, 'lastSync'),
    };
  },

  async saveConfig({ projectId, projectName, token, apiKey }: {
    projectId?: string | null;
    projectName?: string | null;
    token?: string | null;
    apiKey?: string | null;
  }) {
    if (projectId   !== undefined) await storeSet(strapi, 'projectId',   projectId);
    if (projectName !== undefined) await storeSet(strapi, 'projectName', projectName);
    if (token       !== undefined) await storeSet(strapi, 'token',       token);
    if (apiKey      !== undefined) await storeSet(strapi, 'apiKey',      apiKey);
  },

  async disconnect() {
    for (const key of [
      'projectId', 'projectName', 'token', 'apiKey', 'lastSync',
      'lastPreview', 'registerUrl', 'syncsRemaining', 'lastScan', 'isAnon',
    ]) {
      await storeSet(strapi, key, null);
    }
  },

  // ─── Last scan / teaser preview ──────────────────────────────────────────

  async getPreview(): Promise<{
    preview       : Preview | null;
    registerUrl   : string;
    syncsRemaining: number | null;
    lastScan      : string | null;
    isAnon        : boolean;
  }> {
    const raw = await storeGet(strapi, 'lastPreview');
    let preview: Preview | null = null;
    if (raw) { try { preview = JSON.parse(raw) as Preview; } catch { preview = null; } }

    const syncsRaw = await storeGet(strapi, 'syncsRemaining');

    return {
      preview,
      registerUrl   : (await storeGet(strapi, 'registerUrl')) ?? `${HOST}/register`,
      syncsRemaining: syncsRaw != null ? Number(syncsRaw) : null,
      lastScan      : await storeGet(strapi, 'lastScan'),
      isAnon        : (await storeGet(strapi, 'isAnon')) === '1',
    };
  },

  // ─── Live plans (cached 1h, static fallback) ─────────────────────────────

  async getPlans(locale = 'en'): Promise<Plan[]> {
    const cacheKey  = `plans_${locale}`;
    const cachedRaw = await storeGet(strapi, cacheKey);
    const cachedAt  = await storeGet(strapi, `${cacheKey}_at`);
    if (cachedRaw && cachedAt && Date.now() - Number(cachedAt) < 3_600_000) {
      try { return JSON.parse(cachedRaw) as Plan[]; } catch { /* fall through */ }
    }

    try {
      const url = `${HOST}${PLANS_PATH}?keys=free,monitoring,starter&locale=${encodeURIComponent(locale)}`;
      const res = await request('GET', url, { 'ngrok-skip-browser-warning': '1' }, null);
      if (res.status === 200 && Array.isArray(res.body?.plans) && res.body.plans.length) {
        const plans = res.body.plans as Plan[];
        await storeSet(strapi, cacheKey, JSON.stringify(plans));
        await storeSet(strapi, `${cacheKey}_at`, String(Date.now()));
        return plans;
      }
    } catch (err: any) {
      strapi.log.warn('[nextguard] Plans fetch failed: ' + err.message);
    }

    return staticPlans();
  },

  async requestActivationCode(apiKey: string) {
    // Anonymous keys skip device-auth: persist the key, sync immediately and
    // capture the teaser preview the server returns.
    if (isAnonKey(apiKey)) {
      await this.saveConfig({ apiKey });
      await storeSet(strapi, 'isAnon', '1');
      await this.sync();
      return { anon: true as const };
    }

    const res = await request('POST', `${HOST}${ACTIVATE_PATH}`, { 'X-API-Key': apiKey }, '{}');
    if (res.status !== 200) throw new Error(res.body?.error ?? 'Could not request activation code');
    return { ...(res.body as { code: string; expiresIn: number }), anon: false as const };
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
    // Effective signing/auth key: device token if present, else stored api key.
    const authKey = cfg.token || cfg.apiKey || '';
    const anon    = !!authKey && isAnonKey(authKey);

    // Anonymous keys bind to an ephemeral project server-side, so no projectId
    // is required. Account keys require both a device token and a projectId.
    if (!authKey || (!cfg.projectId && !anon)) throw new Error('NextGuard: not configured');

    const appRoot = (strapi as any).dirs?.app?.root ?? process.cwd();
    const payload = {
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
      cmsType    : 'strapi',
      cmsVersion : installedVersion(appRoot, '@strapi/strapi') ?? installedVersion(appRoot, 'strapi') ?? 'unknown',
      nodeVersion: process.version.replace('v', ''),
      siteUrl    : (strapi.config as any).get?.('server.url', '') ?? '',
      components : detectPackages(strapi),
    };

    const bodyStr = JSON.stringify(payload);
    const headers = buildHeaders('POST', SYNC_PATH, bodyStr, authKey);
    const res     = await request('POST', `${HOST}${SYNC_PATH}`, headers, bodyStr);

    if (res.status === 200) {
      await storeSet(strapi, 'lastSync', new Date().toISOString());

      // Capture the teaser preview the server returns so the admin can render
      // the vulnerability table + register CTA right here.
      const data = res.body;
      if (data && typeof data === 'object' && data.preview) {
        await storeSet(strapi, 'lastPreview', JSON.stringify(data.preview));
        await storeSet(strapi, 'registerUrl', data.registerUrl ?? `${HOST}/register`);
        await storeSet(strapi, 'syncsRemaining',
          data.syncsRemaining != null ? String(data.syncsRemaining) : null);
        await storeSet(strapi, 'lastScan', data.scannedAt || new Date().toISOString());
      }
    }

    return { success: res.status === 200, components: payload.components.length, anon };
  },

  async syncIfConfigured() {
    try {
      const cfg     = await this.getConfig();
      const authKey = cfg.token || cfg.apiKey || '';
      const anon    = !!authKey && isAnonKey(authKey);
      if (authKey && (cfg.projectId || anon)) await this.sync();
    } catch (err: any) {
      strapi.log.warn('[nextguard] Sync failed:', err.message);
    }
  },
});

// ─── Static plans fallback (mirrors the website pricing) ─────────────────────

function staticPlans(): Plan[] {
  const base = HOST.replace(/\/$/, '');
  return [
    {
      key: 'free', name: 'Free', priceDisplay: '$0', period: '',
      href: `${base}/register`, cta: 'Create free account', highlighted: false,
      features: [
        'Full vulnerability report (no blur)',
        '1 monitored project',
        'CVE database access',
      ],
    },
    {
      key: 'monitoring', name: 'Monitoring', priceDisplay: '$3', period: '/mo',
      href: `${base}/checkout/monitoring`, cta: 'Get Monitoring', highlighted: true,
      features: [
        'Continuous automatic re-scans',
        'Email alerts on new CVEs',
        'Unlimited scans, no expiry',
      ],
    },
    {
      key: 'starter', name: 'Starter', priceDisplay: '$7', period: '/mo',
      href: `${base}/checkout/starter`, cta: 'Get Starter', highlighted: false,
      features: [
        'Everything in Monitoring',
        'Multiple projects & environments',
        'Scan history & auto-patching',
      ],
    },
  ];
}

export default nextguardService;
