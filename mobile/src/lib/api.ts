// HTTP client for the Karya server: base address, timeouts, and the signed-in user's token.
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getSetting } from './db';

/** The server rejected the sign-in token (expired, revoked or account disabled). */
export class AuthError extends Error {
  constructor(message = 'Signed out. Please sign in again.') {
    super(message);
  }
}

/**
 * Whether teachers can see and edit the server address. Only in development and in "test" builds
 * (EXPO_PUBLIC_SHOW_SERVER=1); a real build has the address built in, and the web app uses its own page's address.
 */
export const serverAddressEditable = __DEV__ || process.env.EXPO_PUBLIC_SHOW_SERVER === '1';

/**
 * Server address, in priority order: the address saved in Settings / on the sign-in screen;
 * EXPO_PUBLIC_API_URL baked in at build time (the APK); on web, the server that served the page;
 * else the Android emulator's host.
 */
export async function apiUrl(db: SQLiteDatabase): Promise<string> {
  const saved = await getSetting(db, 'api_url');
  const fallback =
    process.env.EXPO_PUBLIC_API_URL ||
    (Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : '') ||
    (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
    'http://10.0.2.2:8000';
  return (saved || fallback).replace(/\/+$/, '');
}

export async function request(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticated request to `path` on the Karya server. Throws AuthError on 401. */
export async function apiFetch(db: SQLiteDatabase, path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const token = await getSetting(db, 'auth_token');
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // JSON by default; FormData (recording uploads) sets its own multipart boundary.
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (init.body && !isForm && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await request(`${await apiUrl(db)}${path}`, { ...init, headers }, timeoutMs);
  if (res.status === 401) throw new AuthError();
  return res;
}

/** GET/POST JSON helper for screens; throws with the server's message on failure. */
export async function apiJson<T>(db: SQLiteDatabase, path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(db, path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Server error (HTTP ${res.status})`);
  return body as T;
}
