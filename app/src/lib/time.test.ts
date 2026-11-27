import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../components/ui';
import { iterationSentence, type LevelProgress } from './progress';
import { parseUtc } from './time';

describe('Fabric UTC timestamps without a zone', () => {
  it('are read as UTC, not as local time', () => {
    expect(parseUtc('2026-11-27T12:13:05.1234567')).toBe(Date.parse('2026-11-27T12:13:05.1234567Z'));
    expect(parseUtc('2026-11-27T12:13:05Z')).toBe(Date.parse('2026-11-27T12:13:05Z'));
    expect(parseUtc('2026-11-27T12:13:05+01:00')).toBe(Date.parse('2026-11-27T11:13:05Z'));
    expect(parseUtc(undefined)).toBeNaN();
  });

  it('give the real duration of a run whatever the time zone of the browser', () => {
    const now = Date.parse('2026-11-27T12:16:30Z');
    expect(fmtDuration('2026-11-27T12:13:00.0000000', undefined, now)).toBe('3 min 30 s');
    expect(fmtDuration('2026-11-27T12:13:00.0000000', '2026-11-27T12:15:11.5000000')).toBe('2 min 12 s');
  });
});

describe('iteration sentence', () => {
  const level = (status: LevelProgress['status']) => ({ status, iteration: null }) as LevelProgress;
  it('says a finished level completed all its iterations even without a heartbeat read', () => {
    expect(iterationSentence(level('done'), false)).toBe('Iteration: all completed');
    expect(iterationSentence(level('running'), false)).toBe('Iteration: not available');
    expect(iterationSentence(level('running'), true)).toBe('Iteration: waiting for the first progress file');
  });
});
