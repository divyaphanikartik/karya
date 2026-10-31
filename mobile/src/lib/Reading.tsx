// What the child reads and the teacher marks, shared by the reading check and practice rounds.
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApp } from './AppProvider';
import { FLUENCY_LEVELS, TEXT_MAX_MISTAKES, displayTokens, type Level } from './placement';
import { Card, colors, styles } from './ui';

const FONT: Record<Level, number> = { capital: 44, letter: 44, word: 34, sentence: 28, paragraph: 24, story: 22 };

/** Items with their punctuation; each word is one tap target that toggles misread. */
export function ReadingItems({ items, level, marks, onToggle, suggested = [] }: {
  items: string[]; level: Level; marks: boolean[]; onToggle: (index: number) => void;
  suggested?: boolean[]; // true = the speech model flagged this word
}) {
  const { t } = useApp();
  const rows = useMemo(() => items.map(displayTokens), [items]);
  let flat = 0;
  return (
    <Card style={{ gap: 14, paddingVertical: 20 }}>
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: level === 'paragraph' || level === 'story' || level === 'sentence' ? 'flex-start' : 'center' }}>
          {row.map((word) => {
            const i = flat++;
            const ok = marks[i];
            const flagged = !!suggested[i];
            return (
              <Pressable
                key={i}
                onPress={() => onToggle(i)}
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
  );
}

/** "4 / 5 correct", or for paragraph/story ASER's mistake count and the fluency tick. */
export function MarkSummary({ level, marks, fluent, onFluentChange }: {
  level: Level; marks: boolean[]; fluent: boolean; onFluentChange: (fluent: boolean) => void;
}) {
  const { t } = useApp();
  const correct = marks.filter(Boolean).length;
  if (!FLUENCY_LEVELS.includes(level)) return <Text style={styles.h2}>{correct} / {marks.length} {t.correct}</Text>;
  const mistakes = marks.length - correct;
  return (
    <>
      <Text style={[styles.h2, { color: mistakes > TEXT_MAX_MISTAKES ? colors.warn : colors.text }]}>
        {mistakes} {t.mistakes} · {t.mistakesAllowed}
      </Text>
      <Pressable
        onPress={() => onFluentChange(!fluent)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: fluent }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}
      >
        <Text style={{ fontSize: 26, color: fluent ? colors.good : colors.muted }}>{fluent ? '☑' : '☐'}</Text>
        <Text style={[styles.body, { flex: 1 }]}>{t.fluentCheck}</Text>
      </Pressable>
    </>
  );
}
