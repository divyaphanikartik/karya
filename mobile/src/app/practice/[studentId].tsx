// Practice between checks, at the child's next step. Each round is a fresh set from the practice
// pool (never the check's items, so the next check stays fair), marked like the check; the loop
// repeats until the child passes, then moves to the following step. Missed items can be moved to a
// later day (a practice plan); opening the plan starts with those items. Practice never changes the
// placed level; only the next reading check does.
import { useCallback, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { MonthCalendar } from '../../lib/Calendar';
import { addDays, formatDate, todayISO } from '../../lib/dates';
import {
  completePracticePlan, getPracticeItems, getPracticePlan, getSession, getStudent, latestSession, practicePassedSince,
  practiceRoundsSince, savePractice, schedulePractice, type Student,
} from '../../lib/db';
import { DATE_LOCALES, levelLabel } from '../../lib/i18n';
import {
  FLUENCY_LEVELS, ITEMS_PER_LEVEL, displayTokens, isPassed, itemsToRepeat, pickItems, plannedRound, practiceTarget,
  tokens, type Level,
} from '../../lib/placement';
import type { Language } from '../../lib/placement';
import { MarkSummary, ReadingItems } from '../../lib/Reading';
import { Button, Card, colors, styles } from '../../lib/ui';

type Outcome = { passed: boolean; missed: string[]; repeat: string[]; next: Level | null };

export default function Practice() {
  const { studentId, plan: planId, retest: retestId, lang: langParam } = useLocalSearchParams<{ studentId: string; plan?: string; retest?: string; lang?: Language }>();
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending, syncNow, assessLang } = useApp();
  const lang: Language = langParam && ['en', 'hi', 'te'].includes(langParam) ? langParam : assessLang; // the language of the check this follows
  const [student, setStudent] = useState<Student | null>(null);
  const [pool, setPool] = useState<string[]>([]);
  const [placed, setPlaced] = useState(0);
  const [passedLevels, setPassedLevels] = useState<Set<Level>>(new Set());
  const [level, setLevel] = useState<Level | null>(null);
  const [round, setRound] = useState(1);
  const [items, setItems] = useState<string[]>([]);
  const [marks, setMarks] = useState<boolean[]>([]);
  const [fluent, setFluent] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [state, setState] = useState<'loading' | 'needsCheck' | 'top' | 'ready'>('loading');
  const [saving, setSaving] = useState(false);
  const [activePlan, setActivePlan] = useState<string | null>(null); // plan this round came from
  const [picking, setPicking] = useState(false); // choosing a later day for the missed items
  const [plannedFor, setPlannedFor] = useState<string | null>(null);
  const used = useRef(new Set<string>());

  const newRound = useCallback((pool: string[], next: Level, planned: string[] = []) => {
    // Prefer items not seen in this visit; reuse once the pool runs out.
    if (pool.every((item) => used.current.has(item))) used.current.clear();
    const chosen = planned.length
      ? plannedRound(planned, pool, ITEMS_PER_LEVEL[next])
      : pickItems(pool, ITEMS_PER_LEVEL[next], used.current);
    chosen.forEach((c) => used.current.add(c));
    setItems(chosen);
    setMarks(tokens(chosen).map(() => true));
    setFluent(false);
    setOutcome(null);
    setPicking(false);
    setPlannedFor(null);
  }, []);

  // Pick up where practice left off: the next step above the last check, past any steps passed since.
  const load = useCallback(async () => {
    const s = await getStudent(db, studentId);
    if (!s) return router.back();
    setStudent(s);
    const session = await latestSession(db, s.id, lang);
    if (!session || session.placed_level == null || !session.finished_at) return setState('needsCheck');
    const passed = new Set(await practicePassedSince(db, s.id, session.finished_at, lang));
    // An open plan for this child decides the level and the first items; otherwise the next step.
    const plan = planId ? await getPracticePlan(db, planId) : null;
    const usePlan = plan && plan.student_id === s.id && !plan.done_at ? plan : null;
    // A retest from Claude's summary of a check: the items built from the child's own mistakes.
    let retest: { level: Level; items: string[] } | null = null;
    if (!usePlan && retestId) {
      const from = await getSession(db, retestId);
      try {
        retest = from && from.student_id === s.id && from.ai_summary_json ? JSON.parse(from.ai_summary_json).retest ?? null : null;
      } catch {
        retest = null;
      }
    }
    const target = usePlan ? usePlan.level : retest ? retest.level : practiceTarget(session.placed_level, lang, passed);
    if (!target) return setState('top');
    const items = await getPracticeItems(db, lang, s.grade, target);
    setPool(items);
    setPlaced(session.placed_level);
    setPassedLevels(passed);
    setLevel(target);
    setActivePlan(usePlan?.id ?? null);
    setRound((await practiceRoundsSince(db, s.id, target, session.finished_at, lang)) + 1);
    newRound(items, target, usePlan ? (JSON.parse(usePlan.items_json) as string[]) : retest ? retest.items : []);
    setState('ready');
  }, [db, studentId, planId, retestId, lang, newRound]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  async function check() {
    if (!student || !level) return;
    setSaving(true);
    const judgesFluency = FLUENCY_LEVELS.includes(level);
    const passed = isPassed(level, items, marks, fluent);
    await savePractice(db, { student_id: student.id, language: lang, level, items, marks, fluent: judgesFluency ? fluent : null, passed });
    if (activePlan) {
      await completePracticePlan(db, activePlan);
      setActivePlan(null); // later rounds in this visit are ordinary practice
    }
    await refreshPending();
    void syncNow(); // uploads now if online; otherwise stays queued
    const shown = items.flatMap(displayTokens);
    const next = passed ? practiceTarget(placed, lang, new Set([...passedLevels, level])) : level;
    // Not fluent with no slips: the whole text is what needs going over.
    const repeat = itemsToRepeat(items, marks);
    setOutcome({ passed, missed: shown.filter((_, i) => !marks[i]), repeat: repeat.length ? repeat : items, next });
    setSaving(false);
  }

  async function planLater(date: string) {
    if (!student || !level || !outcome) return;
    await schedulePractice(db, { student_id: student.id, language: lang, level, items: outcome.repeat, due_date: date });
    setPicking(false);
    setPlannedFor(date);
    await refreshPending();
    void syncNow(); // uploads now if online; otherwise stays queued
  }

  function tryAgain() {
    if (!level) return;
    setRound((r) => r + 1);
    newRound(pool, level);
  }

  if (!student || state === 'loading') return <View style={styles.screen} />;

  if (state !== 'ready' || !level) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>{student.name}</Text>
        <Text style={styles.body}>{state === 'top' ? t.practiceTop : t.practiceNeedsCheck}</Text>
        {state === 'needsCheck' && (
          <Button title={t.startCheck} onPress={() => router.replace({ pathname: '/assess/[studentId]', params: { studentId: student.id } })} />
        )}
        <Button title={t.done} kind="secondary" onPress={() => router.dismissTo('/')} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.small}>
        {student.name} · {t.practiceTitle}: {levelLabel(t, lang, level)} · {t.round} {round}
      </Text>
      <Text style={styles.body}>{t.practiceInstruction}</Text>

      <ReadingItems items={items} level={level} marks={marks} onToggle={(i) => !outcome && setMarks((m) => m.map((v, j) => (j === i ? !v : v)))} />
      <MarkSummary level={level} marks={marks} fluent={fluent} onFluentChange={(f) => !outcome && setFluent(f)} />

      {!outcome ? (
        <Button title={t.check} onPress={check} busy={saving} style={{ marginTop: 8 }} />
      ) : outcome.passed ? (
        <Card style={{ borderColor: colors.good, borderWidth: 2 }}>
          <Text style={[styles.h2, { color: colors.good }]}>✓ {t.practicePassed}</Text>
          {outcome.next ? (
            <Button title={`${t.practise}: ${levelLabel(t, lang, outcome.next)}`} onPress={() => { used.current.clear(); void load(); }} />
          ) : (
            <Text style={styles.body}>{t.practiceTop}</Text>
          )}
          <Button title={t.done} kind="secondary" onPress={() => router.dismissTo('/')} />
        </Card>
      ) : (
        <Card style={{ borderColor: colors.warn, borderWidth: 2 }}>
          <Text style={[styles.h2, { color: colors.warn }]}>{t.practiceNotYet}</Text>
          {outcome.missed.length > 0 && (
            <Text style={styles.body}>{t.practiseThese}: <Text style={{ fontWeight: '700' }}>{outcome.missed.join('  ')}</Text></Text>
          )}
          {plannedFor ? (
            <>
              <Text style={[styles.body, { color: colors.good, fontWeight: '700' }]}>
                ✓ {t.practiceScheduled} {formatDate(plannedFor, DATE_LOCALES[uiLang])}
              </Text>
              <Button title={t.done} onPress={() => router.dismissTo('/')} />
            </>
          ) : (
            <>
              <Button title={t.newSet} onPress={tryAgain} />
              <Button title={picking ? '✕' : `📅 ${t.practiseLater}`} kind="secondary" onPress={() => setPicking(!picking)} />
              {picking && (
                <>
                  <Text style={styles.small}>{t.pickPracticeDate}</Text>
                  <MonthCalendar selected={addDays(todayISO(), 1)} minDate={addDays(todayISO(), 1)} onSelect={planLater} />
                </>
              )}
              <Button title={t.stopForToday} kind="secondary" onPress={() => router.dismissTo('/')} />
            </>
          )}
        </Card>
      )}
    </ScrollView>
  );
}
