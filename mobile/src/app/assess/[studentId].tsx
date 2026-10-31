// The reading check. Fully offline: items come from the on-phone content pack, the teacher
// marks misread words, and placement is computed locally. If this language's speech model is
// installed, the recording is transcribed on the phone (then deleted) and the model's flags are
// shown as suggestions; the transcript text syncs later for Claude's note.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { heardAsWritten } from '../../lib/align';
import { levelLabel } from '../../lib/i18n';
import {
  finishSession, getPack, getStudent, saveAttempt, startSession, type ContentPack, type Student,
} from '../../lib/db';
import {
  TIMED_LEVELS, accuracy, displayTokens, expectedLevel, isPassed, nextStep, pickItems, tokens, wordsPerMinute,
  type AttemptOutcome, type Level,
} from '../../lib/placement';
import { speechSupported, transcribeAndDiscard, useWavRecorder, type SpeechResult } from '../../lib/speech';
import { isSpeechEngineAvailable } from '../../lib/speechEngine';
import { Button, Card, colors, styles } from '../../lib/ui';

const FONT: Record<Level, number> = { capital: 44, letter: 44, word: 34, sentence: 28, paragraph: 24, story: 22 };

export default function Assess() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  const db = useSQLiteContext();
  const { t, refreshPending, syncNow } = useApp();
  const recorder = useWavRecorder();

  const [student, setStudent] = useState<Student | null>(null);
  const [pack, setPack] = useState<ContentPack | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<AttemptOutcome[]>([]);
  const [level, setLevel] = useState<Level | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [marks, setMarks] = useState<boolean[]>([]);
  const [duration, setDuration] = useState<number | null>(null);
  const [timerStart, setTimerStart] = useState<number | null>(null); // reading timer for paragraph/story
  const [recorded, setRecorded] = useState(false);
  const [speech, setSpeech] = useState<SpeechResult | null>(null);
  const [suggested, setSuggested] = useState<boolean[]>([]); // true = speech model flagged this word
  const [speechNote, setSpeechNote] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState('');
  const [saving, setSaving] = useState(false);
  const used = useRef(new Set<string>());
  const started = useRef(false);

  // Create the session once and choose the starting level from the child's grade.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const s = await getStudent(db, studentId);
      if (!s) return router.back();
      const p = await getPack(db, s.language, s.grade);
      setStudent(s);
      setPack(p);
      setSessionId(await startSession(db, s));
      const first = nextStep(s.grade, s.language, []);
      if (!first.done) loadLevel(first.level, p);
    })();
  }, [db, studentId]);

  // Never leave the microphone on if the teacher navigates away mid-recording.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => () => {
    if (recorderRef.current.isRecording) void recorderRef.current.stop();
  }, []);

  function loadLevel(next: Level, p: ContentPack) {
    const chosen = pickItems(p.levels[next] ?? [], next, used.current);
    chosen.forEach((c) => used.current.add(c));
    setLevel(next);
    setItems(chosen);
    setMarks(tokens(chosen).map(() => true));
    setDuration(null);
    setTimerStart(null);
    setRecorded(false);
    setSpeech(null);
    setSuggested([]);
    setSpeechNote('');
  }

  // Words with their punctuation for display; one entry per marked token.
  const rows = useMemo(() => items.map(displayTokens), [items]);

  const secondsSince = (start: number) => Math.round((Date.now() - start) / 100) / 10;

  function startTimer() {
    setDuration(null);
    setRecorded(false);
    setTimerStart(Date.now());
  }

  function stopTimer() {
    if (timerStart != null) setDuration(secondsSince(timerStart));
    setTimerStart(null);
  }

  function toggle(index: number) {
    setMarks((m) => m.map((v, i) => (i === index ? !v : v)));
  }

  async function startRecording() {
    setTimerStart(null); // the recording measures the reading time instead
    setMicError('');
    setSpeechNote('');
    if (!(await recorder.start())) setMicError(t.micDenied);
  }

  async function stopRecording() {
    if (!student) return;
    const { uri, duration: seconds } = await recorder.stop();
    setDuration(Math.round(seconds * 10) / 10);
    setRecorded(true);
    setTranscribing(true);
    try {
      const result = await transcribeAndDiscard(db, student.language, uri); // WAV deleted here
      setSpeech(result);
      if (result) {
        const heard = heardAsWritten(tokens(items), tokens([result.transcript]));
        setSuggested(heard.map((ok) => !ok));
        setSpeechNote(t.speechSuggested);
      } else {
        setSuggested([]);
        setSpeechNote(isSpeechEngineAvailable() ? t.speechModelMissing : t.speechNotInBuild);
      }
    } catch {
      // A model that fails to load or decode must not block the check; teacher marks still work.
      setSpeech(null);
      setSuggested([]);
      setSpeechNote(t.speechFailed);
    } finally {
      setTranscribing(false);
    }
  }

  async function saveAndNext() {
    if (!student || !sessionId || !level || !pack) return;
    if (recorder.isRecording) await stopRecording();
    setSaving(true);
    // A timer still running when the teacher saves counts up to now.
    const seconds = timerStart != null ? secondsSince(timerStart) : duration;
    const passed = isPassed(marks);
    await saveAttempt(db, {
      session_id: sessionId, level, items, marks, accuracy: accuracy(marks), passed,
      duration_sec: seconds, asr_transcript: speech?.transcript ?? null, asr_model: speech?.modelId ?? null,
    });
    const all = [...outcomes, { level, passed }];
    setOutcomes(all);
    const step = nextStep(student.grade, student.language, all);
    if (step.done) {
      await finishSession(db, sessionId, step.placed, step.placed < expectedLevel(student.grade, student.language), student.id);
      await refreshPending();
      void syncNow(); // uploads now if online; otherwise stays queued for the next connection
      router.replace({ pathname: '/result/[sessionId]', params: { sessionId } });
      return;
    }
    loadLevel(step.level, pack);
    setSaving(false);
  }

  if (!student || !level) return <View style={styles.screen} />;

  const correct = marks.filter(Boolean).length;
  const timed = TIMED_LEVELS.includes(level);
  const speed = timed ? wordsPerMinute(marks, duration) : null;
  let flat = 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.small}>
        {student.name} · {t.step} {outcomes.length + 1} · {levelLabel(t, student.language, level)}
      </Text>
      <Text style={styles.body}>{t.readInstruction}</Text>

      <Card style={{ gap: 14, paddingVertical: 20 }}>
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: level === 'letter' || level === 'word' ? 'center' : 'flex-start' }}>
            {row.map((word) => {
              const i = flat++;
              const ok = marks[i];
              const flagged = !!suggested[i];
              return (
                <Pressable
                  key={i}
                  onPress={() => toggle(i)}
                  accessibilityLabel={`${word} ${ok ? t.correct : '✗'}`}
                  style={{
                    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 2,
                    borderColor: !ok ? colors.warn : flagged ? colors.amber : 'transparent',
                    borderStyle: ok && flagged ? 'dashed' : 'solid',
                    backgroundColor: ok ? 'transparent' : colors.wrongBg,
                  }}
                >
                  <Text style={{ fontSize: FONT[level], color: ok ? colors.text : colors.warn, textDecorationLine: ok ? 'none' : 'line-through' }}>
                    {word}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </Card>

      <Text style={styles.h2}>{correct} / {marks.length} {t.correct}</Text>

      {timed && !recorder.isRecording && (
        <View style={{ gap: 4 }}>
          {timerStart == null && duration == null && <Text style={styles.small}>{t.timerHelp}</Text>}
          {timerStart != null ? (
            <Button title={`■ ${t.stopTimer}`} kind="danger" onPress={stopTimer} />
          ) : (
            <Button title={`⏱ ${t.startTimer}`} kind="secondary" onPress={startTimer} />
          )}
          {speed != null && timerStart == null && <Text style={styles.small}>{duration}s · {speed} {t.wcpm}</Text>}
        </View>
      )}

      {!speechSupported ? null : recorder.isRecording ? (
        <Button title={`■ ${t.stop}`} kind="danger" onPress={stopRecording} />
      ) : (
        <Button title={recorded ? `● ${t.reRecord}` : `● ${t.record}`} kind="secondary" onPress={startRecording} busy={transcribing} />
      )}
      {recorded && !recorder.isRecording && <Text style={styles.small}>✓ {t.recorded} ({duration}s)</Text>}
      {speech?.transcript ? <Text style={styles.small}>{t.speechHeard}: “{speech.transcript}”</Text> : null}
      {!!speechNote && <Text style={[styles.small, { color: speech ? colors.amber : colors.muted }]}>{speechNote}</Text>}
      {!!micError && <Text style={{ color: colors.warn }}>{micError}</Text>}

      <Button title={t.saveNext} onPress={saveAndNext} busy={saving} style={{ marginTop: 8 }} />
    </ScrollView>
  );
}
