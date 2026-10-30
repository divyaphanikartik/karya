import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { addStudent } from '../../lib/db';
import { LANGUAGE_LABELS } from '../../lib/i18n';
import type { Language } from '../../lib/placement';
import { Button, Chip, colors, styles } from '../../lib/ui';

const GRADES = [1, 2, 3, 4, 5] as const;
const LANGS = ['te', 'hi', 'en'] as const;

export default function NewStudent() {
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending } = useApp();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [school, setSchool] = useState('');
  const [grade, setGrade] = useState<number>(2);
  const [language, setLanguage] = useState<Language>(uiLang);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || !consent) {
      setError(t.required);
      return;
    }
    setBusy(true);
    const id = await addStudent(db, { name, student_code: code, school_code: school, grade, language });
    await refreshPending();
    router.replace({ pathname: '/assess/[studentId]', params: { studentId: id } });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>{t.name}</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={60} autoFocus />
      <Text style={styles.label}>{t.studentCode}</Text>
      <TextInput style={styles.input} value={code} onChangeText={setCode} maxLength={40} />
      <Text style={styles.label}>{t.grade}</Text>
      <Chip options={GRADES} value={grade as (typeof GRADES)[number]} onChange={setGrade} />
      <Text style={styles.label}>{t.readingLanguage}</Text>
      <Chip options={LANGS} value={language} onChange={setLanguage} labels={LANGUAGE_LABELS} />
      <Text style={styles.label}>{t.school}</Text>
      <TextInput style={styles.input} value={school} onChangeText={setSchool} maxLength={60} />
      <Pressable onPress={() => setConsent(!consent)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8 }}>
        <View style={{ width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: colors.primary, backgroundColor: consent ? colors.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          {consent && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
        </View>
        <Text style={[styles.body, { flex: 1 }]}>{t.consent}</Text>
      </Pressable>
      {!!error && <Text style={{ color: colors.warn }}>{error}</Text>}
      <Button title={t.save} onPress={save} busy={busy} style={{ marginTop: 12 }} />
    </ScrollView>
  );
}
