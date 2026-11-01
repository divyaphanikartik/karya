import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { addStudent, studentByCode } from '../../lib/db';
import { cleanName, isValidName } from '../../lib/validate';
import { Button, Chip, colors, styles } from '../../lib/ui';

const GRADES = [1, 2, 3] as const; // Grades 1-3 only

export default function NewStudent() {
  const db = useSQLiteContext();
  const { t, refreshPending, user, assessLang } = useApp();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [grade, setGrade] = useState<number>(2);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    // One specific message at a time, in form order.
    const problem =
      !cleanName(name) ? t.nameRequired
      : !isValidName(name) ? t.nameLetters
      : !code.trim() ? t.codeRequired
      : !consent ? t.consentRequired
      : '';
    setError(problem);
    if (problem) return;
    // Students are shared by the whole school: reuse the existing child instead of adding a duplicate.
    const existing = await studentByCode(db, code, grade);
    if (existing) {
      setError(t.rollExists.replace('{name}', existing.name));
      return;
    }
    setBusy(true);
    const id = await addStudent(db, {
      name: cleanName(name), student_code: code.trim(), school_code: user?.school?.code ?? '', grade, language: assessLang, // the child's first language; checks in other languages are added later
    });
    await refreshPending();
    router.replace({ pathname: '/assess/[studentId]', params: { studentId: id } });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>{t.name}</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={60} autoFocus autoCapitalize="words" placeholder={t.namePlaceholder} />
      <Text style={styles.label}>{t.studentCode}</Text>
      <TextInput style={styles.input} value={code} onChangeText={setCode} maxLength={40} />
      <Text style={styles.label}>{t.grade}</Text>
      <Chip options={GRADES} value={grade as (typeof GRADES)[number]} onChange={setGrade} />
      {user?.school && <Text style={styles.small}>{t.schoolLabel}: {user.school.name}</Text>}
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
