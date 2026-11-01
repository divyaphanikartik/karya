import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { fetchDemoAccounts, type DemoAccount } from '../lib/auth';
import { apiUrl, serverAddressEditable } from '../lib/api';
import { LANGUAGE_LABELS, type UiLang } from '../lib/i18n';
import { Button, Card, Chip, colors, styles } from '../lib/ui';

const UI_LANGS = ['en', 'hi', 'te'] as const;

export default function Login() {
  const db = useSQLiteContext();
  const { t, signIn, uiLang, setUiLang, applyServerUrl } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [base, accounts] = await Promise.all([apiUrl(db), fetchDemoAccounts(db)]);
      if (!cancelled) {
        setServer(base);
        setDemo(accounts);
      }
    })();
    return () => { cancelled = true; };
  }, [db]);

  async function submit(u = username, p = password) {
    if (!u.trim() || !p) return;
    setBusy(true);
    setError('');
    try {
      const user = await signIn(u, p);
      router.replace(user.role === 'admin' ? '/admin' : '/'); // always start on the role's home screen
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function saveServer() {
    await applyServerUrl(server);
    setDemo(await fetchDemoAccounts(db));
    setShowServer(false);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: 32 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>{t.signInTitle}</Text>
        <Chip options={UI_LANGS} value={uiLang} onChange={(l: UiLang) => setUiLang(l)} labels={LANGUAGE_LABELS} />

        <Text style={styles.label}>{t.username}</Text>
        <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
          textContentType="username" autoComplete="username" />
        <Text style={styles.label}>{t.password}</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry
          textContentType="password" autoComplete="password" onSubmitEditing={() => submit()} />
        {!!error && <Text style={{ color: colors.warn }}>{error}</Text>}
        <Button title={t.signIn} onPress={() => submit()} busy={busy} disabled={!username.trim() || !password} />
        <Text style={styles.small}>{t.signInNeedsInternet}</Text>

        {demo.length > 0 && (
          <Card style={{ gap: 8, borderColor: colors.amber }}>
            <Text style={styles.h2}>{t.demoAccounts}</Text>
            {demo.map((a) => (
              <View key={a.username} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.body}>{a.role === 'admin' ? 'Admin' : 'Teacher'} · {a.name}</Text>
                  <Text style={styles.small}>{a.username} / {a.password}</Text>
                </View>
                <Button title={t.useAccount} kind="secondary" onPress={() => {
                  setUsername(a.username);
                  setPassword(a.password);
                  void submit(a.username, a.password);
                }} style={{ minHeight: 40 }} />
              </View>
            ))}
          </Card>
        )}

        {serverAddressEditable && (
          <Pressable onPress={() => setShowServer(!showServer)}>
            <Text style={[styles.small, { color: colors.primary }]}>{t.serverUrl}: {server}</Text>
          </Pressable>
        )}
        {serverAddressEditable && showServer && (
          <View style={{ gap: 8 }}>
            <TextInput style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <Button title={t.saveSettings} kind="secondary" onPress={saveServer} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
