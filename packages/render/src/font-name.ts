/**
 * The family name inside a TrueType or OpenType font file (its `name` table), so the SVG can
 * name the family the renderer actually loaded. Returns null for files it cannot read (WOFF2,
 * collections, damaged files).
 */
export function fontFamilyName(bytes: Uint8Array): string | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return null;
  const tag = v.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const numTables = v.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) return null;
    if (v.getUint32(rec) === 0x6e616d65) nameOffset = v.getUint32(rec + 8);
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return null;
  const count = v.getUint16(nameOffset + 2);
  const strings = nameOffset + v.getUint16(nameOffset + 4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    if (r + 12 > bytes.length) break;
    const platform = v.getUint16(r);
    const encoding = v.getUint16(r + 2);
    const language = v.getUint16(r + 4);
    const nameId = v.getUint16(r + 6);
    const length = v.getUint16(r + 8);
    const offset = strings + v.getUint16(r + 10);
    if ((nameId !== 1 && nameId !== 16) || offset + length > bytes.length) continue;
    let text: string | null = null;
    if (
      platform === 3 &&
      (encoding === 1 || encoding === 10) &&
      (language === 0x409 || !found.has(nameId))
    ) {
      const units: number[] = [];
      for (let k = 0; k + 1 < length; k += 2) units.push(v.getUint16(offset + k));
      text = String.fromCharCode(...units);
    } else if (platform === 1 && encoding === 0 && !found.has(nameId)) {
      text = String.fromCharCode(...bytes.subarray(offset, offset + length));
    }
    if (text) found.set(nameId, text.trim());
  }
  // The typographic family (16) groups weights ("Inter"); the legacy family (1) may not ("Inter Bold").
  return found.get(16) || found.get(1) || null;
}
