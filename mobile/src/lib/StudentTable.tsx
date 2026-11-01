// Students as a table: one block per class (grade), rows in roll-number order, so a teacher or admin
// can find a child at a glance. Callers supply the columns and each row's cells.
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, gradeColors, styles } from './ui';

export type TableColumn = { title: string; flex: number };
export type TableRow = {
  id: string;
  grade: number;
  roll: string; // roll number / code; sorts the rows
  cells: ReactNode[]; // one per column
  onPress: () => void;
};

/** Roll numbers in natural order: 2 before 10, and "A-2" before "A-10". */
export const byRoll = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function groupByGrade<T extends { grade: number; roll: string }>(rows: T[]): [number, T[]][] {
  const grades = [...new Set(rows.map((r) => r.grade))].sort((a, b) => a - b);
  return grades.map((g) => [g, rows.filter((r) => r.grade === g).sort((a, b) => byRoll(a.roll, b.roll))]);
}

/** "1 student" / "12 students" in the app language. */
export const countText = (t: { studentOne: string; studentMany: string }, n: number) =>
  n === 1 ? t.studentOne : t.studentMany.replace('{n}', String(n));

export const cellText = { fontSize: 14, color: colors.text } as const;

export function StudentTable({ rows, columns, gradeLabel, countLabel }: {
  rows: TableRow[]; columns: TableColumn[]; gradeLabel: (grade: number) => string; countLabel: (count: number) => string;
}) {
  return (
    <View style={{ gap: 14 }}>
      {groupByGrade(rows).map(([grade, group]) => (
        <View key={grade} style={{ backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 6, borderLeftColor: gradeColors[grade] ?? colors.primary, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', padding: 10, paddingBottom: 6 }}>
            <Text style={styles.h2}>{gradeLabel(grade)}</Text>
            <Text style={styles.small}>{countLabel(group.length)}</Text>
          </View>
          <View style={{ flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.primarySoft, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border }}>
            {columns.map((c) => (
              <Text key={c.title} style={{ flex: c.flex, fontSize: 12, fontWeight: '700', color: colors.muted }}>{c.title}</Text>
            ))}
          </View>
          {group.map((row, i) => (
            <Pressable
              key={row.id}
              onPress={row.onPress}
              style={{
                flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10, minHeight: 44,
                backgroundColor: i % 2 ? '#FAF9FF' : colors.card, borderBottomWidth: i === group.length - 1 ? 0 : 1, borderColor: colors.border,
              }}
            >
              {columns.map((c, k) => (
                <View key={c.title} style={{ flex: c.flex, paddingRight: 6 }}>{row.cells[k]}</View>
              ))}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
