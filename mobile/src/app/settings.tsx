import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { setSetting } from '../lib/db';
import { LANGUAGE_LABELS, type UiLang } from '../lib/i18n';
import { apiUrl } from '../lib/sync';
import { Button, Card, Chip, colors, styles } from '../lib/ui';

const UI_LANGS = ['en', 'hi', 'te'] as const;

export default function Settings() {
  const db = useSQLiteContext();
  const { t, uiLang, setUiLang, lastSync, syncNow, user, signOut } = useApp();
  const [signOutBlocked, setSignOutBlocked] = useState(false);
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiUrl(db).then((u) => { if (!cancelled) setUrl((current) => current || u); });
    return () => { cancelled = true; };
  }, [db]);

  async function save() {
    await setSetting(db, 'api_url', url.trim());
    setSaved(true);
    void syncNow();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {user && (
        <Card style={{ gap: 6 }}>
          <Text style={styles.small}>{t.signedInAs}</Text>
          <Text style={styles.h2}>{user.name} ({user.username})</Text>
          {user.school && <Text style={styles.small}>{t.schoolLabel}: {user.school.name} · {user.school.code}</Text>}
          <Button title={t.signOut} kind="secondary" onPress={async () => setSignOutBlocked(!(await signOut()))} />
          {signOutBlocked && (
            <>
              <Text style={[styles.small, { color: colors.warn }]}>{t.signOutBlocked}</Text>
              <Button title={t.signOutAnyway} kind="danger" onPress={() => void signOut(true)} />
            </>
          )}
        </Card>
      )}
      <Text style={styles.label}>{t.uiLanguage}</Text>
      <Chip options={UI_LANGS} value={uiLang} onChange={(l: UiLang) => setUiLang(l)} labels={LANGUAGE_LABELS} />

      <Text style={styles.label}>{t.serverUrl}</Text>
      <TextInput style={styles.input} value={url} onChangeText={(v) => { setUrl(v); setSaved(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Button title={saved ? t.saved : t.saveSettings} onPress={save} />
      <Text style={styles.small}>{t.lastSync}: {lastSync ? new Date(lastSync).toLocaleString() : '—'}</Text>
    </ScrollView>
  );
}
