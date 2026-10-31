// Placement result. The level is available immediately (offline); AI notes fill in after sync.
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { ReviewDate } from '../../lib/Calendar';
import {
  getSession, getStudent, sessionAttempts, setNextReview, type Attempt, type Session, type Student,
} from '../../lib/db';
import { levelLabel, placedLabel } from '../../lib/i18n';
import { FLUENCY_LEVELS, TIMED_LEVELS, expectedLevel, nextGoal, speedTarget, wordsPerMinute } from '../../lib/placement';
import { Button, Card, SyncBanner, colors, styles } from '../../lib/ui';

type AiResult = {
  transcript: string | null;
  words_correct_per_minute: number | null;
  feedback: { agreement: string; error_patterns: string[]; note_for_teacher: string; practice_suggestion: string };
  feedback_source: string;
};

export default function Result() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const db = useSQLiteContext();
  const { t, syncing, refreshPending } = useApp();
  const [session, setSession] = useState<Session | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loadError, setLoadError] = useState('');

  // Show the result straight away (it is all on the phone), and reload when a sync finishes so AI
  // notes appear without leaving the screen. Never wait for the sync: it can take minutes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSession(db, sessionId);
        if (!s) throw new Error(`No check found (${sessionId})`);
        const [st, at] = await Promise.all([getStudent(db, s.student_id), sessionAttempts(db, sessionId)]);
        if (cancelled) return;
        setSession(s);
        setStudent(st);
        setAttempts(at);
        setLoadError('');
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, sessionId, syncing]);

  if (loadError && !session) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={[styles.body, { color: colors.warn }]}>{loadError}</Text>
        <Button title={t.done} onPress={() => router.dismissTo('/')} />
      </View>
    );
  }
  if (!session || !student || session.placed_level == null) return <View style={styles.screen} />;

  const needsHelp = Boolean(session.needs_help);
  const lang = session.language;
  const target = speedTarget(session.grade, lang);
  const goal = nextGoal(session.placed_level, lang);
  const targetText = target ? `${target.min}${target.max ? `–${target.max}` : '+'}` : '';
  const meaningMarks: boolean[] | null = session.meaning_marks_json ? JSON.parse(session.meaning_marks_json) : null;
  return (
    <View style={styles.screen}>
      <SyncBanner />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.h1}>{student.name}</Text>
          <Text style={styles.body}>{t.readsAt}: <Text style={{ fontWeight: '700' }}>{placedLabel(t, lang, session.placed_level)}</Text></Text>
          <Text style={styles.body}>{t.expected} {session.grade}: {placedLabel(t, lang, expectedLevel(session.grade, lang))}</Text>
          {goal && <Text style={styles.body}>{t.nextGoal}: <Text style={{ fontWeight: '700' }}>{levelLabel(t, lang, goal)}</Text></Text>}
          {session.meaning_level && meaningMarks && (
            <Text style={styles.body}>
              {t.meaningName[session.meaning_level]}:{' '}
              <Text style={{ fontWeight: '700', color: session.meaning_can_say ? colors.good : colors.warn }}>
                {session.meaning_can_say ? t.canSay : t.cannotSay}
              </Text>
              {` (${meaningMarks.filter(Boolean).length}/${meaningMarks.length})`}
            </Text>
          )}
          <Text style={[styles.badge, { backgroundColor: needsHelp ? colors.warn : colors.good, marginTop: 6 }]}>
            {needsHelp ? t.needsHelp : t.onTrack}
          </Text>
        </Card>

        {/* What to do next: practise the next step now, and the date of the next check. */}
        <Card>
          {goal && (
            <Button
              title={`${t.practise}: ${levelLabel(t, lang, goal)}`}
              onPress={() => router.push({ pathname: '/practice/[studentId]', params: { studentId: student.id } })}
            />
          )}
          <ReviewDate
            date={student.next_review}
            onChange={async (d) => {
              await setNextReview(db, student.id, d);
              setStudent({ ...student, next_review: d });
              await refreshPending();
            }}
          />
        </Card>

        <Text style={styles.h2}>{t.attempts}</Text>
        {attempts.map((a) => {
          const items: string[] = JSON.parse(a.items_json);
          const ai: AiResult | null = a.ai_result_json ? JSON.parse(a.ai_result_json) : null;
          const speed = TIMED_LEVELS.includes(a.level) ? wordsPerMinute(JSON.parse(a.marks_json), a.duration_sec) : null;
          return (
            <Card key={a.id}>
              <Text style={styles.h2}>
                {levelLabel(t, lang, a.level)} ·{' '}
                {FLUENCY_LEVELS.includes(a.level)
                  ? `${(JSON.parse(a.marks_json) as boolean[]).filter((ok) => !ok).length} ${t.mistakes}` +
                    (a.fluent == null ? '' : ` · ${a.fluent ? t.fluent : t.notFluent}`)
                  : `${Math.round(a.accuracy * 100)}%`}{' '}
                {a.passed ? '✓' : '✗'}
              </Text>
              <Text style={styles.small} numberOfLines={2}>{items.join(' · ')}</Text>
              {speed != null && (
                <Text style={[styles.small, target && { color: speed >= target.min ? colors.good : colors.warn }]}>
                  {speed} {t.wcpm}{target ? ` · ${t.speedGoal}: ${targetText}` : ''}
                </Text>
              )}
              {a.ai_status === 'pending' && <Text style={styles.small}>⏳ {t.aiPending}</Text>}
              {a.asr_transcript ? <Text style={styles.small}>{t.speechHeard}: “{a.asr_transcript}”</Text> : null}
              {a.ai_status === 'failed' && <Text style={[styles.small, { color: colors.warn }]}>{t.aiFailed}</Text>}
              {ai && (
                <View style={{ gap: 4, marginTop: 4 }}>
                  {ai.feedback.agreement !== 'no_transcript' && (
                    <Text style={styles.small}>
                      {t.aiAgreement}: {t.agreementNames[ai.feedback.agreement] ?? ai.feedback.agreement.replace(/_/g, ' ')}
                    </Text>
                  )}
                  <Text style={styles.body}>{ai.feedback_source === 'claude' ? t.aiNote : t.ruleNote}: {ai.feedback.note_for_teacher}</Text>
                  <Text style={styles.body}>→ {ai.feedback.practice_suggestion}</Text>
                </View>
              )}
            </Card>
          );
        })}
        <Text style={styles.small}>{t.aiDisclaimer}</Text>
        <Button title={t.done} onPress={() => router.dismissTo('/')} />
      </ScrollView>
    </View>
  );
}
