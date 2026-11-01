import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { formatDate, todayISO } from '../lib/dates';
import { ignoreClosedDb, installedSpeechModel, listPracticePlans, listStudents, type PracticePlanWithStudent, type Student } from '../lib/db';
import { DATE_LOCALES, LANGUAGE_LABELS, levelLabel, placedLabel } from '../lib/i18n';
import { GRADE_FILTERS, LANGS, type GradeFilter } from '../lib/languages';
import { LADDERS, type Language } from '../lib/placement';
import { downloadSpeechModel, fetchSpeechModels, onDeviceSpeechInBuild, type SpeechModelInfo } from '../lib/speech';
import { StudentTable, cellText, countText, type TableColumn, type TableRow } from '../lib/StudentTable';
import { Button, Card, Chip, SyncBanner, colors, gradeColors, languageColors, styles } from '../lib/ui';

export default function Home() {
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending, user, assessLang, setAssessLang } = useApp();
  const [students, setStudents] = useState<Student[]>([]);
  const [plans, setPlans] = useState<PracticePlanWithStudent[]>([]);
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>('all');
  // Offline speech: offer the model for the language being assessed until it is on the phone.
  const [needModel, setNeedModel] = useState<SpeechModelInfo | null>(null);
  const [fetchingModel, setFetchingModel] = useState(false);
  const speechInBuild = onDeviceSpeechInBuild();
  const today = todayISO();
  const locale = DATE_LOCALES[uiLang];
  // Reading checks and planned practice due today or overdue, oldest first, so nobody is forgotten.
  const due = useMemo(() => {
    const checks = students.filter((s) => s.next_review && s.next_review <= today).map((s) => ({
      key: `check-${s.id}`, name: s.name, date: s.next_review!, what: t.readingCheck,
      open: () => router.push({ pathname: '/assess/[studentId]', params: { studentId: s.id } }),
    }));
    const practice = plans.filter((p) => p.due_date <= today).map((p) => ({
      key: `plan-${p.id}`, name: p.name, date: p.due_date,
      what: `${t.practise}: ${levelLabel(t, p.language, p.level)} (${(JSON.parse(p.items_json) as string[]).join(', ')})`,
      open: () => router.push({ pathname: '/practice/[studentId]', params: { studentId: p.student_id, plan: p.id, lang: p.language } }),
    }));
    return [...checks, ...practice].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [students, plans, today, t]);

  // Teaching-at-the-Right-Level groups: how many children are at each level, per reading language.
  const groups = useMemo(() => {
    const counts = new Array<number>(LADDERS[assessLang].length + 1).fill(0);
    let any = false;
    for (const s of students) {
      if (s.last_level == null) continue;
      counts[s.last_level] += 1;
      any = true;
    }
    return any ? ([[assessLang, counts]] as [Language, number[]][]) : [];
  }, [students, assessLang]);

  useFocusEffect(useCallback(() => {
    listStudents(db, assessLang).then(setStudents).catch(ignoreClosedDb);
    listPracticePlans(db, assessLang).then(setPlans).catch(ignoreClosedDb);
    refreshPending();
  }, [db, refreshPending, assessLang]));

  const { online } = useApp();
  useFocusEffect(useCallback(() => {
    if (!speechInBuild) return;
    let cancelled = false;
    (async () => {
      if (await installedSpeechModel(db, assessLang)) return !cancelled && setNeedModel(null);
      try {
        const offer = (await fetchSpeechModels(db)).find((m) => m.language === assessLang) ?? null;
        if (!cancelled) setNeedModel(offer);
      } catch {
        if (!cancelled) setNeedModel(null); // offline: the prompt returns once there is a connection
      }
    })().catch(ignoreClosedDb);
    return () => { cancelled = true; };
  }, [db, assessLang, speechInBuild, online]));

  async function getModel() {
    if (!needModel) return;
    setFetchingModel(true);
    try {
      await downloadSpeechModel(db, needModel);
      setNeedModel(null);
    } catch {
      // stays on screen: tap again to retry
    } finally {
      setFetchingModel(false);
    }
  }

  const columns: TableColumn[] = [
    { title: t.tblRoll, flex: 0.9 }, { title: t.tblName, flex: 1.6 }, { title: t.tblLevel, flex: 1.6 },
    { title: t.tblNext, flex: 1.3 }, { title: t.tblActions, flex: 1.5 },
  ];
  const rows: TableRow[] = students.map((s) => ({
    id: s.id, grade: s.grade, roll: s.student_code || s.name,
    onPress: () => router.push({ pathname: '/assess/[studentId]', params: { studentId: s.id } }),
    cells: [
      <Text key="r" style={[cellText, { fontWeight: '700' }]}>{s.student_code || '—'}</Text>,
      <View key="n">
        <Text style={cellText}>{s.name}</Text>
        <Text style={styles.small}>{s.added_by && s.added_by !== user?.name ? `${t.addedBy}: ${s.added_by}` : ' '}</Text>
      </View>,
      s.last_level != null ? (
        <View key="l" style={{ gap: 2 }}>
          <Text style={cellText}>{placedLabel(t, assessLang, s.last_level)}</Text>
          <Text style={{ fontSize: 12, fontWeight: '700', color: s.last_needs_help ? colors.warn : colors.good }}>{s.last_needs_help ? t.needsHelp : t.onTrack}</Text>
        </View>
      ) : <Text key="l" style={styles.small}>{t.notAssessedLang}</Text>,
      <Text key="d" style={[styles.small, s.next_review && s.next_review < today ? { color: colors.warn } : null]}>
        {s.next_review ? formatDate(s.next_review, locale) : '—'}
      </Text>,
      s.last_level != null ? (
        <View key="a" style={{ gap: 6 }}>
          {s.last_session_id && (
            <Pressable onPress={() => router.push({ pathname: '/result/[sessionId]', params: { sessionId: s.last_session_id! } })}>
              <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>{t.result}</Text>
            </Pressable>
          )}
          <Pressable onPress={() => router.push({ pathname: '/practice/[studentId]', params: { studentId: s.id, lang: assessLang } })}>
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>{t.practise}</Text>
          </Pressable>
        </View>
      ) : <Text key="a" style={styles.small}>—</Text>,
    ],
  }));
  const shown = rows.filter((r) => gradeFilter === 'all' || r.grade === gradeFilter);

  return (
    <View style={styles.screen}>
      <SyncBanner />
      <ScrollView contentContainerStyle={styles.content}>
          <View style={{ gap: 10 }}>
            {user && (
              <Text style={styles.small}>
                {t.signedInAs}: {user.name}{user.school ? ` · ${user.school.name}` : ''}
              </Text>
            )}
            <Text style={styles.label}>{t.assessingIn}</Text>
            <Chip options={LANGS} value={assessLang} onChange={(l) => void setAssessLang(l)} labels={LANGUAGE_LABELS} colorFor={(l) => languageColors[l]} />
            {needModel && (
              <Card style={{ gap: 6, borderColor: colors.accent, borderWidth: 1.5 }}>
                <Text style={styles.h2}>{t.speechPromptTitle}: {LANGUAGE_LABELS[assessLang]}</Text>
                <Text style={styles.small}>{t.speechPromptBody.replace('{size}', `${Math.round(needModel.size_bytes / 1e6)} MB`)}</Text>
                <Button title={fetchingModel ? t.downloading : t.download} onPress={getModel} busy={fetchingModel} />
              </Card>
            )}
            <Button title={`+ ${t.addStudent}`} onPress={() => router.push('/student/new')} />
            {due.length > 0 && (
              <Card style={{ gap: 6, borderColor: colors.warn, borderWidth: 1.5 }}>
                <Text style={styles.h2}>{t.dueNow} ({due.length})</Text>
                {due.map((d) => (
                  <Pressable key={d.key} onPress={d.open}>
                    <Text style={styles.body} numberOfLines={2}>
                      <Text style={{ fontWeight: '700' }}>{d.name}</Text>
                      {' · '}{d.what}{' · '}
                      <Text style={{ color: d.date < today ? colors.warn : colors.text }}>
                        {d.date === today ? t.today : `${formatDate(d.date, locale)} (${t.overdue})`}
                      </Text>
                      {'  ›'}
                    </Text>
                  </Pressable>
                ))}
              </Card>
            )}
            <Button title={`📅 ${t.calendar}`} kind="secondary" onPress={() => router.push('/calendar')} />
            {groups.length > 0 && (
              <Card style={{ gap: 6 }}>
                <Text style={styles.h2}>{t.groupsTitle}</Text>
                {groups.map(([lang, counts]) => (
                  <Text key={lang} style={styles.body}>
                    <Text style={{ fontWeight: '700' }}>{LANGUAGE_LABELS[lang]}: </Text>
                    {counts.flatMap((n, placed) => (n ? [`${placedLabel(t, lang, placed)} ${n}`] : [])).join(' · ')}
                  </Text>
                ))}
                <Text style={styles.small}>{t.groupsHelp}</Text>
              </Card>
            )}
          </View>
          <Text style={styles.label}>{t.tblClass}</Text>
          <Chip options={GRADE_FILTERS} value={gradeFilter} onChange={setGradeFilter} labels={{ all: t.allGrades }} colorFor={(g) => (g === 'all' ? undefined : gradeColors[g])} />
          <Text style={styles.h2}>{countText(t, shown.length)}</Text>
          {students.length === 0 ? <Text style={styles.small}>{t.noStudents}</Text> : <StudentTable rows={shown} columns={columns} gradeLabel={(g) => `${t.tblClass} ${g}`} countLabel={(n) => countText(t, n)} />}
      </ScrollView>
    </View>
  );
}
