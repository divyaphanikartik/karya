// Sign-in. Teachers sign in once while online; the token (valid ~30 days) is kept on the device so
// checks keep working offline. Only the server can create accounts.
import type { SQLiteDatabase } from 'expo-sqlite';
import { apiUrl, request } from './api';
import { getSetting, setSetting } from './db';

export type Role = 'teacher' | 'admin';
export type AuthUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  school: { id: string; name: string; code: string } | null;
};
export type DemoAccount = { username: string; password: string; name: string; role: Role };

export async function loadUser(db: SQLiteDatabase): Promise<AuthUser | null> {
  const [token, user] = await Promise.all([getSetting(db, 'auth_token'), getSetting(db, 'auth_user')]);
  return token && user ? (JSON.parse(user) as AuthUser) : null;
}

export async function signInRequest(db: SQLiteDatabase, username: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await request(`${await apiUrl(db)}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Sign-in failed (HTTP ${res.status})`);
  return body as { token: string; user: AuthUser };
}

export async function saveSession(db: SQLiteDatabase, token: string, user: AuthUser): Promise<void> {
  await setSetting(db, 'auth_token', token);
  await setSetting(db, 'auth_user', JSON.stringify(user));
}

export async function clearSession(db: SQLiteDatabase): Promise<void> {
  await db.runAsync("DELETE FROM settings WHERE key IN ('auth_token', 'auth_user')");
}

/** Best-effort server-side sign-out (revokes the token); ignored when offline. */
export async function revokeToken(db: SQLiteDatabase): Promise<void> {
  const token = await getSetting(db, 'auth_token');
  if (!token) return;
  try {
    await request(`${await apiUrl(db)}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, 8000);
  } catch {
    // offline: the token simply expires
  }
}

/** Test credentials, shown on the sign-in screen only when the server has demo accounts on. */
export async function fetchDemoAccounts(db: SQLiteDatabase): Promise<DemoAccount[]> {
  try {
    const res = await request(`${await apiUrl(db)}/api/auth/demo-accounts`, {}, 8000);
    const body = (await res.json()) as { enabled: boolean; accounts: DemoAccount[] };
    return body.enabled ? body.accounts : [];
  } catch {
    return [];
  }
}
