// App-wide state: the signed-in user, connectivity, background sync, and the UI language.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { AuthError } from './api';
import { clearSession, loadUser, revokeToken, saveSession, signInRequest, type AuthUser } from './auth';
import { clearChildData, getSetting, ignoreClosedDb, setSetting } from './db';
import { STRINGS, type Strings, type UiLang } from './i18n';
import type { Language } from './placement';
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
  /** The language this teacher is assessing in; the student table and new checks follow it. */
  assessLang: Language;
  setAssessLang: (lang: Language) => Promise<void>;
  /** Save the server address and point the online check at it (without this the app keeps judging "online" against the old address). */
  applyServerUrl: (url: string) => Promise<void>;
  t: Strings;
  user: AuthUser | null;
  authReady: boolean;
  signIn: (username: string, password: string) => Promise<AuthUser>;
  /** Returns false (and stays signed in) if checks are still waiting to upload. */
  signOut: (force?: boolean) => Promise<boolean>;
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
  const [assessLang, setAssessLangState] = useState<Language>('en');
  const busy = useRef(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const userRef = useRef<AuthUser | null>(null); // read by syncNow without re-creating it on every sign-in
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const refreshPending = useCallback(async () => {
    try {
      setPending(await pendingCounts(db));
    } catch (e) {
      ignoreClosedDb(e);
    }
  }, [db]);

  const syncNow = useCallback(async () => {
    // Only signed-in teachers sync checks; admins read the dashboard straight from the server.
    if (busy.current || userRef.current?.role !== 'teacher') return;
    busy.current = true;
    setSyncing(true);
    try {
      await runSync(db);
      const t = new Date().toISOString();
      await setSetting(db, 'last_sync', t);
      setLastSync(t);
      setLastError(null);
    } catch (e) {
      if (e instanceof AuthError) {
        // Token expired or account disabled: sign out locally. Queued checks stay on the phone and
        // upload after the next sign-in.
        await clearSession(db);
        setUser(null);
      }
      // Offline or server unreachable: data stays queued on the phone. Never shown to the teacher; the
      // reason is in the development console.
      console.warn('Sync did not finish:', e instanceof Error ? e.message : String(e));
      setLastError(e instanceof Error ? e.message : String(e));
      void NetInfo.refresh(); // a failed request is the quickest sign the connection dropped
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

  const setAssessLang = useCallback(async (lang: Language) => {
    setAssessLangState(lang);
    await setSetting(db, 'assess_lang', lang);
  }, [db]);

  const signIn = useCallback(async (username: string, password: string) => {
    const { token, user: signedIn } = await signInRequest(db, username, password);
    // A phone holds one school's children. Switching school clears them, but never unsent work.
    const previousSchool = await getSetting(db, 'school_id');
    const schoolId = signedIn.school?.id ?? '';
    if (previousSchool && previousSchool !== schoolId) {
      const counts = await pendingCounts(db);
      if (counts.records + counts.notes > 0) {
        throw new Error('This phone has checks from another school that have not uploaded yet. Sign in to that school and sync first.');
      }
      await clearChildData(db);
    }
    await saveSession(db, token, signedIn);
    await setSetting(db, 'school_id', schoolId);
    userRef.current = signedIn;
    setUser(signedIn);
    void syncNow();
    return signedIn;
  }, [db, syncNow]);

  const signOut = useCallback(async (force = false) => {
    if (!force) {
      if (userRef.current?.role === 'teacher') await syncNow();
      const counts = await pendingCounts(db);
      setPending(counts);
      if (counts.records + counts.notes > 0) return false;
    }
    await revokeToken(db);
    await clearSession(db);
    setUser(null);
    return true;
  }, [db, syncNow]);

  useEffect(() => {
    (async () => {
      const saved = await loadUser(db);
      userRef.current = saved;
      setUser(saved);
      setAuthReady(true);
      if (saved?.role === 'teacher') void syncNow(); // catch up on anything queued while the app was closed
      const savedLang = (await getSetting(db, 'ui_lang')) as UiLang | null;
      if (savedLang && savedLang in STRINGS) setUiLangState(savedLang);
      const savedAssess = (await getSetting(db, 'assess_lang')) as Language | null;
      setAssessLangState(savedAssess && savedAssess in STRINGS ? savedAssess : savedLang && savedLang in STRINGS ? savedLang : 'en');
      setLastSync(await getSetting(db, 'last_sync'));
      await refreshPending();
    })().catch(ignoreClosedDb);
  }, [db, refreshPending, syncNow]);

  // Sync automatically whenever connectivity returns or the app comes to the foreground.
  // "Online" means the Karya server answers, checked against its own /api/health. (NetInfo's
  // default Google check is also blocked on the web build by the cross-origin isolation headers.)
  const configureNet = useCallback(async () => {
    const base = await apiUrl(db);
    // Re-check every 15 s while online (default 60 s) so losing signal shows up quickly.
    NetInfo.configure({
      reachabilityUrl: `${base}/api/health`,
      reachabilityTest: async (res) => res.status === 200,
      reachabilityLongTimeout: 15_000,
      reachabilityShortTimeout: 5_000,
      reachabilityRequestTimeout: 5_000,
      useNativeReachability: false,
    });
  }, [db]);

  const applyServerUrl = useCallback(async (url: string) => {
    await setSetting(db, 'api_url', url.trim());
    await configureNet(); // the online check follows the new address straight away
    await NetInfo.refresh();
  }, [db, configureNet]);

  useEffect(() => {
    let unsubNet = () => {};
    let cancelled = false;
    configureNet().then(() => {
      if (cancelled) return;
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
    // In Chrome, NetInfo listens to navigator.connection, which often stays silent when the laptop
    // goes into airplane mode; the browser's own online/offline events do fire, so re-check on those.
    const recheck = () => void NetInfo.refresh();
    const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
    win?.addEventListener('online', recheck);
    win?.addEventListener('offline', recheck);
    return () => {
      cancelled = true;
      unsubNet();
      appSub.remove();
      win?.removeEventListener('online', recheck);
      win?.removeEventListener('offline', recheck);
    };
  }, [configureNet, syncNow]);

  // Retry every 2 minutes while online with work queued (e.g. a server that was briefly unreachable).
  const waiting = pending.notes + pending.records;
  useEffect(() => {
    if (!online || waiting === 0) return;
    const timer = setInterval(() => void syncNow(), 120_000);
    return () => clearInterval(timer);
  }, [online, waiting, syncNow]);

  return (
    <Ctx.Provider value={{
      online, syncing, pending, lastSync, lastError, syncNow, refreshPending, uiLang, setUiLang, assessLang, setAssessLang, applyServerUrl, t: STRINGS[uiLang],
      user, authReady, signIn, signOut,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
