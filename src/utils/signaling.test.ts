import { describe, expect, it } from 'vitest';
import { generateRoomCode, isPrivateIpv4Address, normalizeRoomCode } from './signaling';

describe('room codes', () => {
  it('generates 12 cryptographically random characters', () => {
    const codes = Array.from({ length: 100 }, () => generateRoomCode());
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{12}$/);
    }
    expect(new Set(codes).size).toBeGreaterThan(90);
  });

  describe('LAN network detection', () => {
    it('recognizes private IPv4 ranges used by local networks', () => {
      expect(isPrivateIpv4Address('10.20.30.40')).toBe(true);
      expect(isPrivateIpv4Address('172.16.0.1')).toBe(true);
      expect(isPrivateIpv4Address('172.31.255.255')).toBe(true);
      expect(isPrivateIpv4Address('192.168.1.25')).toBe(true);
    });

    it('does not classify public or boundary addresses as private LAN addresses', () => {
      expect(isPrivateIpv4Address('172.15.255.255')).toBe(false);
      expect(isPrivateIpv4Address('172.32.0.1')).toBe(false);
      expect(isPrivateIpv4Address('8.8.8.8')).toBe(false);
    });
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
