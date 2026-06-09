import React, { useEffect, useRef, useState } from 'react';
import {
  Box, Button, Flex, Typography, TextInput,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/admin/strapi-admin';

const API = '/api/nextguard';

interface PreviewVuln {
  severity        : string;
  componentName   : string;
  installedVersion: string;
  title           : string;
  fixedIn         : string;
  cveId           : string;
}

interface Preview {
  available: boolean;
  summary  : { total: number; critical: number; high: number; medium: number; low: number };
  shown    : PreviewVuln[];
  hidden   : number;
}

interface Plan {
  key         : string;
  name        : string;
  priceDisplay: string;
  period      : string;
  cta         : string;
  highlighted : boolean;
  features    : string[];
  href        : string;
}

interface Config {
  connected     : boolean;
  isAnon        : boolean;
  projectId     : string | null;
  projectName   : string | null;
  lastSync      : string | null;
  preview       : Preview | null;
  registerUrl   : string;
  syncsRemaining: number | null;
  lastScan      : string | null;
}

type Step = 'idle' | 'requesting' | 'code' | 'syncing';

const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#dc2626', HIGH: '#ea580c', MEDIUM: '#ca8a04', LOW: '#65a30d',
};

function Dot({ ok }: { ok: boolean }) {
  const color = ok ? '#16a34a' : '#ef4444';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6,
      padding:'3px 10px', borderRadius:12, fontSize:12, fontWeight:600,
      background: ok ? 'rgba(22,163,74,0.12)' : 'rgba(239,68,68,0.1)',
      color, border:`1px solid ${ok ? 'rgba(22,163,74,0.3)' : 'rgba(239,68,68,0.2)'}`,
    }}>
      <span style={{ width:7, height:7, borderRadius:'50%', background:color, flexShrink:0 }} />
      {ok ? 'Connected' : 'Not connected'}
    </span>
  );
}

export default function Settings() {
  const { get, post } = useFetchClient();

  const [cfg, setCfg]         = useState<Config | null>(null);
  const [plans, setPlans]     = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey]   = useState('');
  const [step, setStep]       = useState<Step>('idle');
  const [code, setCode]       = useState('');
  const [expiry, setExpiry]   = useState(0);
  const [error, setError]     = useState('');
  const [ok, setOk]           = useState('');
  const pollRef               = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const { data } = await get<Config>(`${API}/settings`);
      setCfg(data);
    } catch { /* noop */ }
    setLoading(false);
  };

  const loadPlans = async () => {
    try {
      const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en';
      const { data } = await get<{ plans: Plan[] }>(
        `${API}/plans?locale=${encodeURIComponent(locale)}`
      );
      if (Array.isArray(data?.plans)) setPlans(data.plans);
    } catch { /* noop */ }
  };

  useEffect(() => {
    load();
    loadPlans();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const clear = () => { setError(''); setOk(''); };

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    clear();
    if (!apiKey.trim()) { setError('API key required'); return; }
    setStep('requesting');
    try {
      const { data } = await post<{ anon: boolean; code?: string; expiresIn?: number }>(
        `${API}/request-code`, { apiKey: apiKey.trim() }
      );
      // Anonymous / free key: no device code — already synced. Refresh to show
      // the server-returned vulnerability teaser.
      if (data.anon) {
        setStep('idle');
        setApiKey('');
        setOk('Connected. Free scan complete — see the results below.');
        await load();
        return;
      }
      setCode(data.code!);
      setExpiry(Math.floor((data.expiresIn ?? 900) / 60));
      setStep('code');
      startPolling(data.code!);
    } catch (e: any) {
      setError(e?.response?.data?.error?.message ?? 'Failed to get activation code');
      setStep('idle');
    }
  }

  function startPolling(activationCode: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await get<{ status: string }>(
          `${API}/poll-status?code=${encodeURIComponent(activationCode)}&apiKey=${encodeURIComponent(apiKey.trim())}`
        );
        if (data.status === 'authorized') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setStep('idle');
          setApiKey('');
          setCode('');
          setOk('Connected successfully!');
          await load();
        }
      } catch { /* keep polling */ }
    }, 3000);
  }

  async function handleSync() {
    clear();
    setStep('syncing');
    try {
      const { data } = await post<{ components: number }>(`${API}/sync`, {});
      setOk(`Sync complete — ${data.components} packages sent.`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error?.message ?? 'Sync failed');
    }
    setStep('idle');
  }

  async function handleDisconnect() {
    clear();
    await post(`${API}/disconnect`, {});
    await load();
  }

  if (loading) {
    return (
      <Box padding={8}>
        <Typography>Loading…</Typography>
      </Box>
    );
  }

  const connected = cfg?.connected ?? false;

  const cardStyle: React.CSSProperties = {
    padding      : 24,
    background   : '#fff',
    borderRadius : 6,
    border       : '1px solid rgba(0,0,0,0.08)',
    boxShadow    : '0 1px 4px rgba(0,0,0,0.06)',
  };

  const preview = cfg?.preview ?? null;
  const hasVulns = !!preview && preview.available && !!preview.summary && preview.summary.total > 0;

  // ── Vulnerability teaser table (first 3 vulns + blurred hidden rows) ──
  const renderTeaser = () => {
    if (!preview) return null;
    if (!hasVulns) {
      if (!preview.available) return null;
      return (
        <Box style={{ ...cardStyle, marginTop:24, background:'rgba(22,163,74,0.06)',
          border:'1px solid rgba(22,163,74,0.3)' }}>
          <Typography textColor="success600" variant="omega" fontWeight="bold">
            ✓ No known vulnerabilities found on your site.
          </Typography>
        </Box>
      );
    }
    const s = preview.summary;
    const hiddenRows = Math.min(3, preview.hidden || 0);
    const th: React.CSSProperties = { textAlign:'left', padding:'8px 10px', fontSize:11,
      fontWeight:700, color:'#6b7280', borderBottom:'1px solid rgba(0,0,0,0.08)' };
    const td: React.CSSProperties = { padding:'8px 10px', fontSize:13,
      borderBottom:'1px solid rgba(0,0,0,0.05)' };

    return (
      <Box style={{ ...cardStyle, marginTop:24 }}>
        <Typography variant="delta" style={{ display:'block', marginBottom:4 }}>
          Vulnerabilities detected on your site
        </Typography>
        <Typography variant="beta" style={{ display:'block', color:'#dc2626', marginBottom:4 }}>
          {s.total} vulnerabilities found
        </Typography>
        {cfg?.lastScan && (
          <Typography variant="pi" textColor="neutral500" style={{ display:'block', marginBottom:8 }}>
            🕐 Last scan: {new Date(cfg.lastScan).toLocaleString()}
          </Typography>
        )}
        <Box style={{ fontFamily:'monospace', fontSize:13, marginBottom:12 }}>
          <span style={{ color:'#dc2626' }}>{s.critical} CRITICAL</span>{' · '}
          <span style={{ color:'#ea580c' }}>{s.high} HIGH</span>{' · '}
          <span style={{ color:'#ca8a04' }}>{s.medium} MEDIUM</span>{' · '}
          <span style={{ color:'#65a30d' }}>{s.low ?? 0} LOW</span>
        </Box>

        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead><tr>
            <th style={{ ...th, width:90 }}>Severity</th>
            <th style={th}>Component</th>
            <th style={{ ...th, width:100 }}>Installed</th>
            <th style={th}>Vulnerability</th>
            <th style={{ ...th, width:100 }}>Fixed in</th>
          </tr></thead>
          <tbody>
            {(preview.shown ?? []).map((v, i) => {
              const sev = (v.severity || '—').toUpperCase();
              return (
                <tr key={i}>
                  <td style={td}><span style={{ fontWeight:700, fontSize:11,
                    color: SEV_COLOR[sev] ?? '#65a30d' }}>{sev}</span></td>
                  <td style={td}><strong>{v.componentName || '—'}</strong></td>
                  <td style={td}><code>{v.installedVersion || '—'}</code></td>
                  <td style={td}>{v.title || v.cveId || '—'}</td>
                  <td style={td}>{v.fixedIn || '—'}</td>
                </tr>
              );
            })}
            {Array.from({ length: hiddenRows }).map((_, i) => (
              <tr key={`h${i}`} style={{ filter:'blur(3px)', userSelect:'none' }}>
                <td style={td}><span style={{ fontWeight:700, fontSize:11, color:'#dc2626' }}>HIGH</span></td>
                <td style={td}>███████</td>
                <td style={td}>█.█.█</td>
                <td style={td}>████ ███ ██████ ████</td>
                <td style={td}>█.█.█</td>
              </tr>
            ))}
          </tbody>
        </table>

        {preview.hidden > 0 && (
          <Typography variant="omega" fontWeight="bold" style={{ display:'block', color:'#b45309', marginTop:12 }}>
            +{preview.hidden} more vulnerabilities hidden — register free to see the full report.
          </Typography>
        )}
        <Box style={{ marginTop:14 }}>
          <a href={cfg?.registerUrl || 'https://nextguardhq.com/register'} target="_blank" rel="noreferrer"
            style={{ display:'inline-block', padding:'10px 18px', borderRadius:4, fontWeight:600,
              background:'#4945ff', color:'#fff', textDecoration:'none' }}>
            Register free for the full report + continuous monitoring
          </a>
        </Box>
        {cfg?.syncsRemaining != null && (
          <Typography variant="pi" textColor="neutral500" style={{ display:'block', marginTop:10 }}>
            ⓘ This free key has {cfg.syncsRemaining} scan(s) left and expires in 2 hours. When it runs out,
            generate a new free key on the home page or register for unlimited continuous monitoring.
          </Typography>
        )}
      </Box>
    );
  };

  // ── Plans panel (mirrors the website pricing) ──
  const renderPlans = () => {
    if (!plans.length) return null;
    return (
      <Box style={{ marginTop:24, background:'#0f172a', borderRadius:8, padding:'22px 20px', color:'#e2e8f0' }}>
        <Typography variant="delta" style={{ display:'block', color:'#fff', marginBottom:6 }}>
          Why connect a NextGuard account?
        </Typography>
        <Typography variant="omega" style={{ display:'block', color:'#94a3b8', marginBottom:18, lineHeight:1.6 }}>
          A free scan only shows a teaser and the key expires in 2 hours. With an account this site becomes a
          monitored project: the full report, automatic re-scans, and email alerts whenever a new CVE hits your
          Strapi packages.
        </Typography>
        <Box style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
          {plans.map((p) => {
            const hot = p.highlighted || p.key === 'monitoring';
            return (
              <Box key={p.key} style={{ flex:'1 1 220px', minWidth:200, background:'#111827',
                border:`1px solid ${hot ? '#0ea5e9' : '#1e293b'}`, borderRadius:6, padding:'14px 16px' }}>
                <Flex justifyContent="space-between" alignItems="baseline" style={{ marginBottom:10 }}>
                  <strong style={{ fontSize:14, color:'#fff' }}>{p.name}</strong>
                  <span style={{ fontSize:13, color:'#38bdf8', fontWeight:700 }}>{p.priceDisplay}{p.period}</span>
                </Flex>
                <ul style={{ listStyle:'none', margin:'0 0 12px', padding:0, fontSize:12,
                  color:'#cbd5e1', lineHeight:1.5 }}>
                  {(p.features ?? []).map((f, i) => (
                    <li key={i} style={{ marginBottom:5 }}><span style={{ color:'#22c55e' }}>✓</span> {f}</li>
                  ))}
                </ul>
                <a href={p.href} target="_blank" rel="noreferrer"
                  style={{ display:'block', textAlign:'center', padding:'8px 10px', borderRadius:4,
                    fontWeight:600, textDecoration:'none', boxSizing:'border-box',
                    background: hot ? '#4945ff' : 'transparent',
                    color: hot ? '#fff' : '#e2e8f0', border: hot ? 'none' : '1px solid #334155' }}>
                  {p.cta}
                </a>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  };

  return (
    <Box padding={8} background="neutral100" minHeight="100vh">
      <Box style={{ maxWidth: 960 }}>
        {/* Header */}
        <Flex justifyContent="space-between" alignItems="center" paddingBottom={6}>
          <Box>
            <Typography variant="alpha" style={{ display:'block' }}>NextGuard</Typography>
            <Typography variant="epsilon" textColor="neutral600" style={{ display:'block', marginTop:4 }}>
              CVE monitoring for your Strapi 5 packages
            </Typography>
          </Box>
          <Dot ok={connected} />
        </Flex>

        {/* Alerts */}
        {error && (
          <Box style={{ padding:12, marginBottom:16, borderRadius:4,
            background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.2)' }}>
            <Typography textColor="danger600" variant="omega">{error}</Typography>
          </Box>
        )}
        {ok && (
          <Box style={{ padding:12, marginBottom:16, borderRadius:4,
            background:'rgba(22,163,74,0.08)', border:'1px solid rgba(22,163,74,0.2)' }}>
            <Typography textColor="success600" variant="omega">{ok}</Typography>
          </Box>
        )}

        {connected ? (
          /* Connected */
          <Box style={cardStyle}>
            <Typography variant="delta" style={{ display:'block', marginBottom:16 }}>
              Connected to NextGuard
            </Typography>
            <Box style={{ marginBottom:8 }}>
              <Typography variant="omega" textColor="neutral600">Project: </Typography>
              <Typography variant="omega" fontWeight="bold">
                {cfg?.projectName || cfg?.projectId}
              </Typography>
            </Box>
            {cfg?.lastSync && (
              <Box style={{ marginBottom:16 }}>
                <Typography variant="omega" textColor="neutral600">Last sync: </Typography>
                <Typography variant="omega">
                  {new Date(cfg.lastSync).toLocaleString()}
                </Typography>
              </Box>
            )}
            <Flex gap={2} style={{ marginTop:16 }}>
              <Button onClick={handleSync} loading={step === 'syncing'} disabled={step === 'syncing'}>
                Sync now
              </Button>
              <Button variant="danger-light" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </Flex>
          </Box>
        ) : step !== 'code' ? (
          /* Step 1: enter API key */
          <Box style={cardStyle}>
            <Typography variant="delta" style={{ display:'block', marginBottom:8 }}>
              Connect to NextGuard
            </Typography>
            <Typography variant="omega" textColor="neutral600" style={{ display:'block', marginBottom:16 }}>
              Paste an API key to scan this site — <strong>no paid plan required</strong>. Run the{' '}
              <a href="https://nextguardhq.com/#scan" target="_blank" rel="noreferrer"
                style={{ color:'#4945ff' }}>free CMS scan</a> for a temporary key, or paste your{' '}
              <a href="https://nextguardhq.com/account" target="_blank" rel="noreferrer"
                style={{ color:'#4945ff' }}>Account → API Keys</a> to link this site for continuous monitoring.
            </Typography>
            <form onSubmit={handleRequestCode}>
              <Box style={{ marginBottom:16 }}>
                <TextInput
                  label="API Key"
                  name="apiKey"
                  type="password"
                  placeholder="vs_pk_…"
                  value={apiKey}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
                  hint="Free keys start with vs_pk_anon_ (temporary). Account keys start with vs_pk_."
                />
              </Box>
              <Button type="submit" loading={step === 'requesting'} disabled={step === 'requesting'}>
                Connect &amp; scan
              </Button>
            </form>
          </Box>
        ) : (
          /* Step 2: show code */
          <Box style={cardStyle}>
            <Typography variant="delta" style={{ display:'block', marginBottom:8 }}>
              Authorize connection
            </Typography>
            <Typography variant="omega" textColor="neutral600" style={{ display:'block', marginBottom:16 }}>
              Go to{' '}
              <a href="https://nextguardhq.com/account" target="_blank" rel="noreferrer"
                style={{ color:'#4945ff' }}>
                nextguardhq.com → Account → Connected Devices
              </a>{' '}
              and enter this code (expires in {expiry} min):
            </Typography>
            <Box style={{
              padding:'16px 24px', marginBottom:16, borderRadius:6, textAlign:'center',
              letterSpacing:10, fontSize:30, fontWeight:700, fontFamily:'monospace',
              color:'#4945ff', background:'rgba(73,69,255,0.06)', border:'1px solid rgba(73,69,255,0.2)',
            }}>
              {code}
            </Box>
            <Flex alignItems="center" gap={3}>
              <Typography variant="omega" textColor="neutral500">Waiting for authorization…</Typography>
              <Button variant="tertiary" onClick={() => {
                if (pollRef.current) clearInterval(pollRef.current);
                setStep('idle');
                setCode('');
              }}>
                Cancel
              </Button>
            </Flex>
          </Box>
        )}

        {/* Vulnerability teaser (server-captured sync preview) */}
        {renderTeaser()}

        {/* Plans panel (live from /api/public/plans, static fallback) — shown
            while not connected to a paid project, to drive registration. */}
        {!connected && renderPlans()}

        {/* Info */}
        <Box style={{ padding:12, marginTop:24, borderRadius:4,
          background:'rgba(0,0,0,0.03)', border:'1px solid rgba(0,0,0,0.06)' }}>
          <Typography variant="pi" textColor="neutral500">
            NextGuard monitors your Strapi packages for CVEs and security advisories.
            Syncs automatically every day at 02:00 UTC.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
