// Admin: create teacher accounts, disable/enable them, reset passwords.
import { useCallback, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { apiJson } from '../../lib/api';
import { Button, Card, colors, styles } from '../../lib/ui';

type Teacher = { id: string; username: string; name: string; active: boolean; checks: number; last_sync: string | null };

export default function Teachers() {
  const db = useSQLiteContext();
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTeachers((await apiJson<{ teachers: Teacher[] }>(db, '/api/admin/teachers')).teachers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [db]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function run(action: () => Promise<unknown>, done: string) {
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const add = () => run(async () => {
    await apiJson(db, '/api/admin/teachers', { method: 'POST', body: JSON.stringify({ name: name.trim(), username: username.trim(), password }) });
    setName(''); setUsername(''); setPassword('');
  }, `Account created. Share the username and password with the teacher.`);

  const patch = (id: string, body: object, done: string) =>
    run(() => apiJson(db, `/api/admin/teachers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), done);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: 6 }}>
        <Text style={styles.h2}>Add a teacher</Text>
        <Text style={styles.label}>Full name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} />
        <Text style={styles.label}>Username</Text>
        <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} maxLength={40} />
        <Text style={styles.label}>Temporary password (8+ characters)</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry maxLength={200} />
        <Button title="Create account" onPress={add} disabled={name.trim().length < 2 || username.trim().length < 3 || password.length < 8} />
      </Card>
      {!!message && <Text style={{ color: colors.good }}>{message}</Text>}
      {!!error && <Text style={{ color: colors.warn }}>{error}</Text>}

      <Text style={styles.h2}>Teachers ({teachers.length})</Text>
      {teachers.map((tch) => (
        <Card key={tch.id} style={{ gap: 6, opacity: tch.active ? 1 : 0.6 }}>
          <Text style={styles.h2}>{tch.name}</Text>
          <Text style={styles.small}>
            {tch.username} · {tch.checks} checks · last sync {tch.last_sync ? new Date(tch.last_sync).toLocaleString() : 'never'}
            {tch.active ? '' : ' · DISABLED'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button title={tch.active ? 'Disable' : 'Enable'} kind={tch.active ? 'danger' : 'secondary'}
              onPress={() => patch(tch.id, { active: !tch.active }, tch.active ? `${tch.name} disabled and signed out.` : `${tch.name} enabled.`)} />
            <Button title="Reset password" kind="secondary" onPress={() => { setResetFor(tch.id); setNewPassword(''); }} />
          </View>
          {resetFor === tch.id && (
            <View style={{ gap: 6 }}>
              <TextInput style={styles.input} value={newPassword} onChangeText={setNewPassword} secureTextEntry placeholder="New password (8+ characters)" />
              <Button title="Save new password" disabled={newPassword.length < 8}
                onPress={() => { setResetFor(null); void patch(tch.id, { password: newPassword }, `Password changed for ${tch.name}; they must sign in again.`); }} />
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}
