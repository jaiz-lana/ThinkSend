export const OPTICAL_QR_MAX_BYTES = 100 * 1024 * 1024;
export const OPTICAL_QR_CHUNK_SIZE = 550;

export type OpticalQrMetadata = {
  name: string;
  size: number;
  total: number;
  hash: string;
  streamId?: string;
};

export function validateOpticalQrMetadata(
  name: string,
  size: number,
  total: number,
  hash: string
): OpticalQrMetadata | null {
  if (typeof name !== 'string' || name.length > 255) return null;
  if (!Number.isSafeInteger(size) || size < 0 || size > OPTICAL_QR_MAX_BYTES) return null;
  if (!Number.isSafeInteger(total) || total < 1) return null;

  const expectedChunks = Math.max(1, Math.ceil(size / OPTICAL_QR_CHUNK_SIZE));
  if (total !== expectedChunks) return null;

  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  return { name, size, total, hash: hash.toLowerCase() };
}
