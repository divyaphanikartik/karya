import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { listInstalledSpeechModels, setSetting, type InstalledSpeechModel } from '../lib/db';
import { LANGUAGE_LABELS, type UiLang } from '../lib/i18n';
import { deleteSpeechModel, downloadSpeechModel, fetchSpeechModels, speechSupported, type SpeechModelInfo } from '../lib/speech';
import { apiUrl } from '../lib/sync';
import { Button, Card, Chip, colors, styles } from '../lib/ui';

const UI_LANGS = ['en', 'hi', 'te'] as const;
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export default function Settings() {
  const db = useSQLiteContext();
  const { t, uiLang, setUiLang, lastSync, syncNow, online } = useApp();
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [available, setAvailable] = useState<SpeechModelInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledSpeechModel[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modelError, setModelError] = useState('');

  const [reload, setReload] = useState(0);
  const refreshModels = useCallback(() => setReload((n) => n + 1), []);

  // Installed models come from SQLite (works offline); the offer list needs the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [u, have] = await Promise.all([apiUrl(db), listInstalledSpeechModels(db)]);
      if (cancelled) return;
      setUrl((current) => current || u);
      setInstalled(have);
      try {
        const offer = await fetchSpeechModels(db);
        if (!cancelled) { setAvailable(offer); setModelError(''); }
      } catch {
        if (!cancelled) setModelError(t.serverUnreachable);
      }
    })();
    return () => { cancelled = true; };
  }, [db, online, reload, t.serverUnreachable]);

  async function save() {
    await setSetting(db, 'api_url', url.trim());
    setSaved(true);
    void syncNow();
    refreshModels();
  }

  async function install(model: SpeechModelInfo) {
    setBusyId(model.id);
    setModelError('');
    try {
      await downloadSpeechModel(db, model);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setInstalled(await listInstalledSpeechModels(db));
    }
  }

  async function remove(model: InstalledSpeechModel) {
    setBusyId(model.id);
    await deleteSpeechModel(db, model);
    setInstalled(await listInstalledSpeechModels(db));
    setBusyId(null);
  }

  // Show every model the server offers, plus any installed one the server no longer lists.
  const ids = [...new Set([...available.map((m) => m.id), ...installed.map((m) => m.id)])];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.label}>{t.uiLanguage}</Text>
      <Chip options={UI_LANGS} value={uiLang} onChange={(l: UiLang) => setUiLang(l)} labels={LANGUAGE_LABELS} />

      {speechSupported && <Text style={styles.label}>{t.speechModels}</Text>}
      {speechSupported && <Text style={styles.small}>{t.speechModelsHelp}</Text>}
      {speechSupported && ids.map((id) => {
        const offer = available.find((m) => m.id === id);
        const have = installed.find((m) => m.id === id);
        const language = (offer?.language ?? have?.language) as UiLang;
        return (
          <Card key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.h2}>{LANGUAGE_LABELS[language]}</Text>
              <Text style={styles.small}>{mb(offer?.size_bytes ?? have?.size_bytes ?? 0)} · {offer?.source ?? id}</Text>
              {have && <Text style={[styles.small, { color: colors.good }]}>✓ {t.installed}</Text>}
            </View>
            {have ? (
              <Button title={t.remove} kind="secondary" onPress={() => remove(have)} busy={busyId === id} />
            ) : offer ? (
              <Button title={busyId === id ? t.downloading : t.download} onPress={() => install(offer)} busy={busyId === id} disabled={!!busyId} />
            ) : null}
          </Card>
        );
      })}
      {!!modelError && <Text style={[styles.small, { color: colors.warn }]}>{modelError}</Text>}

      <Text style={styles.label}>{t.serverUrl}</Text>
      <TextInput style={styles.input} value={url} onChangeText={(v) => { setUrl(v); setSaved(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Button title={saved ? t.saved : t.saveSettings} onPress={save} />
      <Text style={styles.small}>{t.lastSync}: {lastSync ? new Date(lastSync).toLocaleString() : '—'}</Text>
    </ScrollView>
  );
}
