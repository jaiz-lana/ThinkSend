import { describe, expect, it } from 'vitest';
import {
  OPTICAL_QR_MAX_BYTES,
  validateOpticalQrMetadata,
} from './qrMetadata';

describe('validateOpticalQrMetadata', () => {
  const hash = 'a'.repeat(64);

  it('accepts valid metadata', () => {
    expect(validateOpticalQrMetadata('photo.jpg', 1_000, 2, hash)).toEqual({
      name: 'photo.jpg',
      size: 1_000,
      total: 2,
      hash,
    });
  });

  it('rejects invalid SHA-256 values', () => {
    expect(validateOpticalQrMetadata('file.txt', 1, 1, 'abc')).toBeNull();
    expect(validateOpticalQrMetadata('file.txt', 1, 1, 'z'.repeat(64))).toBeNull();
  });

  it('rejects unsafe sizes and mismatch chunk counts', () => {
    expect(validateOpticalQrMetadata('file.txt', OPTICAL_QR_MAX_BYTES + 1, 190909, hash)).toBeNull();
    expect(validateOpticalQrMetadata('file.txt', 1_000, 1, hash)).toBeNull();
  });

  it('rejects filenames longer than 255 characters', () => {
    expect(validateOpticalQrMetadata('x'.repeat(256), 1, 1, hash)).toBeNull();
  });
});
