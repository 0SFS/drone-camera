export interface ZipEntry { name: string; bytes: Uint8Array }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** STORE-method zip. JPEGs are already compressed, so method 0 keeps the bytes intact. */
export function storeZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoded = entries.map(entry => ({ ...entry, name: new TextEncoder().encode(entry.name), crc: crc32(entry.bytes) }));
  const localSize = encoded.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = encoded.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  const locals: number[] = [];
  for (const entry of encoded) {
    locals.push(offset);
    u32(view, offset, 0x04034b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 0);
    u16(view, offset + 8, 0);
    u16(view, offset + 10, 0);
    u16(view, offset + 12, 0);
    u32(view, offset + 14, entry.crc);
    u32(view, offset + 18, entry.bytes.length);
    u32(view, offset + 22, entry.bytes.length);
    u16(view, offset + 26, entry.name.length);
    u16(view, offset + 28, 0);
    out.set(entry.name, offset + 30);
    out.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
  }
  const centralStart = offset;
  encoded.forEach((entry, index) => {
    u32(view, offset, 0x02014b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 20);
    u16(view, offset + 8, 0);
    u16(view, offset + 10, 0);
    u16(view, offset + 12, 0);
    u16(view, offset + 14, 0);
    u32(view, offset + 16, entry.crc);
    u32(view, offset + 20, entry.bytes.length);
    u32(view, offset + 24, entry.bytes.length);
    u16(view, offset + 28, entry.name.length);
    u16(view, offset + 30, 0);
    u16(view, offset + 32, 0);
    u16(view, offset + 34, 0);
    u16(view, offset + 36, 0);
    u32(view, offset + 38, 0);
    u32(view, offset + 42, locals[index] ?? 0);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  u32(view, offset, 0x06054b50);
  u16(view, offset + 4, 0);
  u16(view, offset + 6, 0);
  u16(view, offset + 8, encoded.length);
  u16(view, offset + 10, encoded.length);
  u32(view, offset + 12, centralSize);
  u32(view, offset + 16, centralStart);
  u16(view, offset + 20, 0);
  return out;
}

export function shotName(index: number, pitchDeg: number, yawDeg: number): string {
  const pitch = pitchDeg.toFixed(2);
  const yaw = yawDeg.toFixed(2);
  return `DJI_${String(index).padStart(3, "0")}_${pitch}_${yaw}.jpg`;
}

export function downloadZip(name: string, bytes: Uint8Array): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
