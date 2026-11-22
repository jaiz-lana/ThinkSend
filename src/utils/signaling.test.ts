import { describe, expect, it } from 'vitest';
import { generateRoomCode, normalizeRoomCode } from './signaling';

describe('room codes', () => {
  it('generates 12 cryptographically random characters', () => {
    const codes = Array.from({ length: 100 }, () => generateRoomCode());
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{12}$/);
    }
    expect(new Set(codes).size).toBeGreaterThan(90);
  });

  it('normalizes and preserves legacy 4-16 character codes', () => {
    expect(normalizeRoomCode(' abcd-1234 ')).toBe('ABCD-1234');
    expect(normalizeRoomCode('ABCD')).toBe('ABCD');
    expect(normalizeRoomCode('abcdefghijklmnop')).toBe('ABCDEFGHIJKLMNOP');
  });

  it('rejects room codes outside the legacy length range', () => {
    expect(normalizeRoomCode('ABC')).toBe('');
    expect(normalizeRoomCode('abcdefghijklmnopq')).toBe('');
  });
});
