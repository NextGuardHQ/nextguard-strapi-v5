import React, { useEffect, useRef, useState } from 'react';
import {
  Box, Button, Flex, Typography, TextInput,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/admin/strapi-admin';

const API = '/api/nextguard';

interface Config {
  connected   : boolean;
  projectId   : string | null;
  projectName : string | null;
  lastSync    : string | null;
}

type Step = 'idle' | 'requesting' | 'code' | 'syncing';

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

  useEffect(() => {
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const clear = () => { setError(''); setOk(''); };

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    clear();
    if (!apiKey.trim()) { setError('API key required'); return; }
    setStep('requesting');
    try {
      const { data } = await post<{ code: string; expiresIn: number }>(
        `${API}/request-code`, { apiKey: apiKey.trim() }
      );
      setCode(data.code);
      setExpiry(Math.floor(data.expiresIn / 60));
      setStep('code');
      startPolling(data.code);
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

  return (
    <Box padding={8} background="neutral100" minHeight="100vh">
      <Box style={{ maxWidth: 600 }}>
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
              Get your API key at{' '}
              <a href="https://nextguardhq.com/account" target="_blank" rel="noreferrer"
                style={{ color:'#4945ff' }}>
                nextguardhq.com → Account → API Keys
              </a>
              . Requires Starter plan.
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
                  hint="Your NextGuard account API key (vs_pk_*)"
                />
              </Box>
              <Button type="submit" loading={step === 'requesting'} disabled={step === 'requesting'}>
                Get activation code
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
