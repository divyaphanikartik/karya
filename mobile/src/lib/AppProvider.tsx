// App-wide state: connectivity, background sync, and the teacher's UI language.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { getSetting, setSetting } from './db';
import { STRINGS, type Strings, type UiLang } from './i18n';
import { apiUrl, pendingCounts, runSync } from './sync';

type AppCtx = {
  online: boolean;
  syncing: boolean;
  pending: { notes: number; records: number };
  lastSync: string | null;
  lastError: string | null;
  syncNow: () => Promise<void>;
  refreshPending: () => Promise<void>;
  uiLang: UiLang;
  setUiLang: (lang: UiLang) => Promise<void>;
  t: Strings;
};

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [online, setOnline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState({ notes: 0, records: 0 });
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [uiLang, setUiLangState] = useState<UiLang>('en');
  const busy = useRef(false);

  const refreshPending = useCallback(async () => setPending(await pendingCounts(db)), [db]);

  const syncNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      await runSync(db);
      const t = new Date().toISOString();
      await setSetting(db, 'last_sync', t);
      setLastSync(t);
      setLastError(null);
    } catch (e) {
      // Offline or server unreachable: data stays queued on the phone.
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setSyncing(false);
      await refreshPending();
    }
  }, [db, refreshPending]);

  const setUiLang = useCallback(async (lang: UiLang) => {
    setUiLangState(lang);
    await setSetting(db, 'ui_lang', lang);
  }, [db]);

  useEffect(() => {
    (async () => {
      const saved = (await getSetting(db, 'ui_lang')) as UiLang | null;
      if (saved && saved in STRINGS) setUiLangState(saved);
      setLastSync(await getSetting(db, 'last_sync'));
      await refreshPending();
    })();
  }, [db, refreshPending]);

  // Sync automatically whenever connectivity returns or the app comes to the foreground.
  // "Online" means the Karya server answers, checked against its own /api/health. (NetInfo's
  // default Google check is also blocked on the web build by the cross-origin isolation headers.)
  useEffect(() => {
    let unsubNet = () => {};
    let cancelled = false;
    apiUrl(db).then((base) => {
      if (cancelled) return;
      NetInfo.configure({
        reachabilityUrl: `${base}/api/health`,
        reachabilityTest: async (res) => res.status === 200,
        useNativeReachability: false,
      });
      unsubNet = NetInfo.addEventListener((s) => {
        const up = Boolean(s.isConnected) && s.isInternetReachable !== false;
        setOnline(up);
        if (up) void syncNow();
      });
    });
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        NetInfo.fetch().then((s) => {
          if (s.isConnected && s.isInternetReachable !== false) void syncNow();
        });
      }
    });
    return () => {
      cancelled = true;
      unsubNet();
      appSub.remove();
    };
  }, [db, syncNow]);

  // Retry every 2 minutes while online with work queued (e.g. a server that was briefly unreachable).
  const waiting = pending.notes + pending.records;
  useEffect(() => {
    if (!online || waiting === 0) return;
    const timer = setInterval(() => void syncNow(), 120_000);
    return () => clearInterval(timer);
  }, [online, waiting, syncNow]);

  return (
    <Ctx.Provider value={{ online, syncing, pending, lastSync, lastError, syncNow, refreshPending, uiLang, setUiLang, t: STRINGS[uiLang] }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
