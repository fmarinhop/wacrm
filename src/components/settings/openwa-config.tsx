'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Loader2,
  QrCode,
  Smartphone,
  Trash2,
  Unplug,
  XCircle,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// ============================================================
// Unofficial (QR) WhatsApp channel — settings card.
//
// Companion to <WhatsAppConfig /> (the official Meta channel). Drives
// the /api/openwa/config lifecycle and renders the connect flow:
//
//   Connect → gateway session starts → `session.qr` webhook writes the
//   QR string to openwa_config → the Realtime subscription below picks
//   up the row change → <QRCodeSVG> renders it → user scans with the
//   phone → `session.authenticated` flips status to connected → the
//   same subscription swaps the QR for the connected summary. No
//   polling in the happy path; a slow interval poll covers missed
//   webhook/Realtime delivery while a scan is pending.
// ============================================================

type ChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'authenticating'
  | 'connected'
  | 'failed';

interface ChannelState {
  configured: boolean;
  status: ChannelStatus;
  phone?: string | null;
  push_name?: string | null;
  qr_code?: string | null;
  last_error?: string | null;
}

const AWAITING_SCAN: ChannelStatus[] = ['connecting', 'qr_ready', 'authenticating'];

export function OpenWAConfig() {
  const t = useTranslations('Settings.openwa');
  const { accountId, loading: authLoading } = useAuth();

  const [state, setState] = useState<ChannelState>({
    configured: false,
    status: 'disconnected',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'connect' | 'disconnect' | 'remove'>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchState = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/openwa/config${refresh ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load channel state');
      setState(data as ChannelState);
    } catch (err) {
      console.error('[openwa-config] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — live-refreshed from the gateway so a status change
  // that happened while no webhook could reach us (e.g. local dev) is
  // reconciled on page open.
  useEffect(() => {
    if (authLoading || !accountId) return;
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchState(true);
  }, [authLoading, accountId, fetchState]);

  // Realtime: the webhook route writes QR/status onto openwa_config;
  // this subscription is what makes the QR appear and rotate live.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`openwa-config-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'openwa_config',
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setState({ configured: false, status: 'disconnected' });
            return;
          }
          const row = payload.new as Partial<ChannelState> & { status: ChannelStatus };
          setState((prev) => ({
            ...prev,
            configured: true,
            status: row.status,
            phone: row.phone ?? prev.phone,
            push_name: row.push_name ?? prev.push_name,
            qr_code: row.qr_code ?? null,
            last_error: row.last_error ?? null,
          }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId]);

  // Fallback poll while a scan is pending — covers a missed webhook or
  // a dropped Realtime socket. /api/openwa/qr re-fetches from the
  // gateway when the stored QR is stale.
  useEffect(() => {
    if (!AWAITING_SCAN.includes(state.status)) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/openwa/qr');
        if (!res.ok) return;
        const data = await res.json();
        setState((prev) =>
          AWAITING_SCAN.includes(prev.status)
            ? { ...prev, qr_code: data.qrCode ?? prev.qr_code }
            : prev,
        );
        // Status may have advanced server-side without an event landing.
        fetchState(true);
      } catch {
        // Transient network failure — next tick retries.
      }
    }, 20_000);
    return () => clearInterval(interval);
  }, [state.status, fetchState]);

  const act = async (
    action: 'connect' | 'disconnect' | 'remove',
  ) => {
    if (action === 'remove' && !window.confirm(t('removeConfirm'))) return;
    setBusy(action);
    try {
      const res = await fetch('/api/openwa/config', {
        method: action === 'remove' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(action !== 'remove'
          ? { body: JSON.stringify({ action }) }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action}`);
      if (action === 'remove') {
        setState({ configured: false, status: 'disconnected' });
        toast.success(t('removed'));
      } else if (action === 'disconnect') {
        setState((prev) => ({ ...prev, status: 'disconnected', qr_code: null }));
        toast.success(t('disconnected'));
      } else {
        setState((prev) => ({
          ...prev,
          configured: true,
          status: (data.status as ChannelStatus) ?? 'connecting',
          qr_code: null,
          last_error: null,
        }));
        toast.success(t('connectStarted'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(null);
    }
  };

  const statusBadge = () => {
    switch (state.status) {
      case 'connected':
        return (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-4 w-4" /> {t('statusConnected')}
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-destructive">
            <XCircle className="h-4 w-4" /> {t('statusFailed')}
          </span>
        );
      case 'connecting':
      case 'qr_ready':
      case 'authenticating':
        return (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-500">
            <Loader2 className="h-4 w-4 animate-spin" /> {t(`status_${state.status}`)}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Unplug className="h-4 w-4" /> {t('statusDisconnected')}
          </span>
        );
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const awaitingScan = state.configured && AWAITING_SCAN.includes(state.status);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" /> {t('title')}
            </CardTitle>
            <CardDescription className="mt-1.5">{t('description')}</CardDescription>
          </div>
          {state.configured && statusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>{t('riskTitle')}</AlertTitle>
          <AlertDescription>{t('riskDescription')}</AlertDescription>
        </Alert>

        {state.status === 'connected' && (
          <div className="flex items-center gap-3 rounded-lg border p-4">
            <Smartphone className="h-8 w-8 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium">{state.push_name || t('connectedFallbackName')}</p>
              <p className="text-sm text-muted-foreground">{state.phone}</p>
            </div>
          </div>
        )}

        {awaitingScan && (
          <div className="flex flex-col items-center gap-4 rounded-lg border p-6">
            {state.qr_code ? (
              <>
                <div className="rounded-md bg-white p-3">
                  {/* The OpenWA gateway may deliver the QR either as a raw
                      string to encode OR as an already-rendered PNG data
                      URL (`data:image/...`). Re-encoding a multi-KB data
                      URL through QRCodeSVG overflows the QR capacity and
                      throws, so render pre-rendered images as-is and only
                      encode raw strings. */}
                  {/^data:image\//.test(state.qr_code) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={state.qr_code}
                      alt="WhatsApp QR code"
                      width={224}
                      height={224}
                    />
                  ) : (
                    <QRCodeSVG value={state.qr_code} size={224} marginSize={0} />
                  )}
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>{t('scanStep1')}</li>
                  <li>{t('scanStep2')}</li>
                  <li>{t('scanStep3')}</li>
                </ol>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                {t('waitingForQr')}
              </div>
            )}
          </div>
        )}

        {state.last_error && state.status !== 'connected' && (
          <Alert variant="destructive">
            <AlertDescription>{state.last_error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          {(!state.configured ||
            state.status === 'disconnected' ||
            state.status === 'failed') && (
            <Button onClick={() => act('connect')} disabled={busy !== null}>
              {busy === 'connect' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <QrCode className="mr-2 h-4 w-4" />
              )}
              {state.configured ? t('reconnect') : t('connect')}
            </Button>
          )}
          {state.configured &&
            (state.status === 'connected' || awaitingScan) && (
              <Button
                variant="outline"
                onClick={() => act('disconnect')}
                disabled={busy !== null}
              >
                {busy === 'disconnect' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="mr-2 h-4 w-4" />
                )}
                {t('disconnect')}
              </Button>
            )}
          {state.configured && (
            <Button
              variant="destructive"
              onClick={() => act('remove')}
              disabled={busy !== null}
            >
              {busy === 'remove' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t('limitationsNote')}</p>
      </CardContent>
    </Card>
  );
}
