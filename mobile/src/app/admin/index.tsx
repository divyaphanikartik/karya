// Admin dashboard: the whole school at a glance, read live from the server (needs internet).
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { apiJson } from '../../lib/api';
import { LANGUAGE_LABELS, placedLabel } from '../../lib/i18n';
import type { Language } from '../../lib/placement';
import { StudentTable, cellText, countText, type TableColumn, type TableRow } from '../../lib/StudentTable';
import { GRADE_FILTERS, LANGS, type GradeFilter } from '../../lib/languages';
import { Button, Card, Chip, colors, gradeColors, languageColors, styles } from '../../lib/ui';

type StudentRow = {
  id: string; name: string; student_code: string; grade: number; language: Language; check_language: Language | null;
  placed_level: number | null; needs_help: boolean | null; finished_at: string | null; last_teacher: string | null; added_by: string | null;
};
type Overview = {
  school: { name: string; code: string };
  totals: { students: number; assessed: number; needs_help: number; checks: number; teachers: number };
  levels: Record<string, { placed_level: number; students: number }[]>;
  needs_help: StudentRow[];
  recent_checks: { id: string; student_id: string; student_name: string; student_code: string; teacher_name: string; language: Language; placed_level: number; needs_help: boolean; finished_at: string }[];
};

const TILE_COLORS: Record<string, string> = { 'Need help': colors.warn }; // the rest use the brand colour

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

export default function AdminHome() {
  const db = useSQLiteContext();
  const { t, user } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [lang, setLang] = useState<'all' | Language>('all'); // which language's results the table shows
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, s] = await Promise.all([
        apiJson<Overview>(db, '/api/admin/overview'),
        apiJson<{ students: StudentRow[] }>(db, lang === 'all' ? '/api/admin/students' : `/api/admin/students?language=${lang}`),
      ]);
      setData(o);
      setStudents(s.students);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [db, lang]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const openStudent = (id: string) => router.push({ pathname: '/admin/student/[id]', params: { id } });
  const columns: TableColumn[] = [
    { title: 'Roll no', flex: 0.9 }, { title: 'Name', flex: 1.7 }, { title: 'Reading level', flex: 1.7 },
    { title: 'Last check', flex: 1.2 }, { title: 'Added by', flex: 1.1 },
  ];
  const rows: TableRow[] = students.map((s) => ({
    id: s.id, grade: s.grade, roll: s.student_code || s.name, onPress: () => openStudent(s.id),
    cells: [
      <Text key="r" style={[cellText, { fontWeight: '700' }]}>{s.student_code || '—'}</Text>,
      <View key="n">
        <Text style={cellText}>{s.name}</Text>
        <Text style={styles.small}>{lang === 'all' ? '' : LANGUAGE_LABELS[lang]}</Text>
      </View>,
      s.placed_level != null ? (
        <View key="l" style={{ gap: 2 }}>
          <Text style={cellText}>{placedLabel(t, s.check_language ?? s.language, s.placed_level)}</Text>
          <Text style={{ fontSize: 12, fontWeight: '700', color: s.needs_help ? colors.warn : colors.good }}>{s.needs_help ? t.needsHelp : t.onTrack}</Text>
        </View>
      ) : <Text key="l" style={styles.small}>Not assessed yet</Text>,
      <Text key="d" style={styles.small}>{day(s.finished_at)}</Text>,
      <Text key="b" style={styles.small}>{s.added_by ?? '—'}</Text>,
    ],
  }));

  const shown = rows.filter((r) => gradeFilter === 'all' || r.grade === gradeFilter);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <Text style={styles.small}>{t.signedInAs}: {user?.name} · {data?.school.name ?? user?.school?.name}</Text>
      {!!error && <Card><Text style={{ color: colors.warn }}>{error}</Text><Button title="Retry" kind="secondary" onPress={load} /></Card>}

      {data && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {([
              ['Students', data.totals.students], ['Assessed', data.totals.assessed],
              ['Need help', data.totals.needs_help], ['Checks', data.totals.checks], ['Teachers', data.totals.teachers],
            ] as const).map(([label, n]) => (
              <Card key={label} style={{ minWidth: 110, flexGrow: 1, alignItems: 'center', borderTopWidth: 4, borderTopColor: TILE_COLORS[label] ?? colors.accent }}>
                <Text style={[styles.h1, { color: label === 'Need help' ? (n === 0 ? colors.muted : colors.warn) : colors.primary }]}>{n}</Text>
                <Text style={styles.small}>{label}</Text>
              </Card>
            ))}
          </View>

          <Card style={{ gap: 6 }}>
            <Text style={styles.h2}>Children by reading level</Text>
            {Object.keys(data.levels).length === 0 && <Text style={styles.small}>No checks synced yet.</Text>}
            {Object.entries(data.levels).map(([lang, rows]) => (
              <Text key={lang} style={styles.body}>
                <Text style={{ fontWeight: '700' }}>{LANGUAGE_LABELS[lang as Language]}: </Text>
                {rows.map((r) => `${placedLabel(t, lang as Language, r.placed_level)} ${r.students}`).join(' · ')}
              </Text>
            ))}
          </Card>

          {data.needs_help.length > 0 && (
            <Card style={{ gap: 6 }}>
              <Text style={styles.h2}>Need extra help ({data.needs_help.length})</Text>
              {data.needs_help.map((s) => (
                <Pressable key={s.id} onPress={() => openStudent(s.id)}>
                  <Text style={styles.body}>
                    {s.name} <Text style={styles.small}>· {s.student_code} · Grade {s.grade} · {LANGUAGE_LABELS[s.language]} · {placedLabel(t, s.check_language ?? s.language, s.placed_level ?? 0)}</Text>
                  </Text>
                </Pressable>
              ))}
            </Card>
          )}

          <Card style={{ gap: 6 }}>
            <Text style={styles.h2}>Recent checks</Text>
            {data.recent_checks.length === 0 && <Text style={styles.small}>None yet.</Text>}
            {data.recent_checks.map((c) => (
              <Pressable key={c.id} onPress={() => openStudent(c.student_id)}>
                <Text style={styles.body}>
                  {c.student_name} → {placedLabel(t, c.language, c.placed_level)}
                  <Text style={styles.small}> · by {c.teacher_name} · {day(c.finished_at)}</Text>
                </Text>
              </Pressable>
            ))}
          </Card>

          <Text style={styles.label}>{t.assessingIn}</Text>
          <Chip options={['all', ...LANGS] as const} value={lang} onChange={setLang} labels={{ all: t.allLanguages, ...LANGUAGE_LABELS }} colorFor={(l) => (l === 'all' ? undefined : languageColors[l])} />
          <Text style={styles.label}>{t.tblClass}</Text>
          <Chip options={GRADE_FILTERS} value={gradeFilter} onChange={setGradeFilter} labels={{ all: t.allGrades }} colorFor={(g) => (g === 'all' ? undefined : gradeColors[g])} />
          <Text style={styles.h2}>{countText(t, shown.length)}</Text>
          <StudentTable rows={shown} columns={columns} gradeLabel={(g) => `${t.tblClass} ${g}`} countLabel={(n) => countText(t, n)} />
        </>
      )}

      <Button title="Manage teachers" onPress={() => router.push('/admin/teachers')} />
    </ScrollView>
  );
}
