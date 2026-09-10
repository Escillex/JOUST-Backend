import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { completedMatchData } from '../src/tournament/match/match-completion.helper';

describe('completedMatchData', () => {
  it('stamps status and completedAt, and keeps the caller fields', () => {
    const before = Date.now();
    const data = completedMatchData({ winnerId: 'u1', isBye: true });
    expect(data.status).toBe('COMPLETED');
    expect(data.winnerId).toBe('u1');
    expect(data.isBye).toBe(true);
    expect(data.completedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('works with no caller fields (a dead match has no winner)', () => {
    const data = completedMatchData();
    expect(data).toMatchObject({ status: 'COMPLETED' });
    expect(data.completedAt).toBeInstanceOf(Date);
  });
});

// Matches reach COMPLETED from a dozen places and there is no chokepoint to
// funnel them through, so the guard is this: nothing may write that status by
// hand. A thirteenth site added without the helper silently loses its timestamp
// and quietly biases every duration metric, which is exactly the failure this
// test exists to make loud.
describe('no match completion bypasses the helper', () => {
  const SRC = join(__dirname, '..', 'src');
  const ALLOWED = ['match-completion.helper.ts'];

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  it('has no hand-written `status: MatchStatus.COMPLETED` outside the helper', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOWED.some((a) => file.endsWith(a))) continue;
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        // `status: MatchStatus.COMPLETED` inside a `where`/filter is a read, not
        // a write; those are indented under `where:` and use the same token, so
        // narrow to the update shape by requiring `data:` on the same line or the
        // literal to sit in an object that also names a writable column.
        if (/status:\s*MatchStatus\.COMPLETED/.test(line)) {
          const context = src.split('\n').slice(Math.max(0, i - 6), i + 1).join('\n');
          const isWrite = /\bdata:\s*\{[^}]*$/m.test(context) || /\bdata:\s*\{/.test(line);
          if (isWrite) offenders.push(`${file.replace(SRC, 'src')}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
