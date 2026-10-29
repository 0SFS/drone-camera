export interface JpegShotMeta {
  model: string;
  make: string;
  software: string;
  xmpNamespace: string;
  exposureDen: number;
  focalMm: number;
  focal35mm: number;
  width: number;
  height: number;
  when: Date;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gimbalPitchDeg: number;
  /** Stabilized camera heading and optical-axis roll; legacy saves default to aircraft yaw/zero roll. */
  gimbalYawDeg?: number;
  gimbalRollDeg?: number;
  aglM: number;
  mslM: number;
  focalPx: number;
  scale: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1;
}

function rational(value: number): [number, number] {
  const den = 100000000;
  const num = Math.round(value * den);
  const divisor = gcd(num, den);
  return [num / divisor, den / divisor];
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(`${text}\0`);
}

interface TiffEntry { tag: number; type: number; count: number; inline?: number; bytes?: Uint8Array }

function writeIfd(entries: TiffEntry[], dataOffset: number): { ifd: Uint8Array; data: Uint8Array; nextData: number } {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const ifd = new Uint8Array(2 + sorted.length * 12 + 4);
  const view = new DataView(ifd.buffer);
  view.setUint16(0, sorted.length, true);
  const blobs: Uint8Array[] = [];
  let cursor = dataOffset;
  sorted.forEach((entry, index) => {
    const at = 2 + index * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.count, true);
    const size = entry.type === 2 ? entry.count : entry.type === 5 ? 8 * entry.count : entry.type === 3 ? 2 : 4;
    if (entry.bytes && size > 4) {
      view.setUint32(at + 8, cursor, true);
      blobs.push(entry.bytes);
      cursor += entry.bytes.length;
    } else if (entry.bytes) {
      ifd.set(entry.bytes.subarray(0, 4), at + 8);
    } else {
      view.setUint32(at + 8, entry.inline ?? 0, true);
    }
  });
  const data = new Uint8Array(blobs.reduce((sum, blob) => sum + blob.length, 0));
  let write = 0;
  for (const blob of blobs) { data.set(blob, write); write += blob.length; }
  return { ifd, data, nextData: cursor };
}

function app1(payload: Uint8Array): Uint8Array {
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, payload.length + 2, false);
  segment.set(payload, 4);
  return segment;
}

function exifPayload(meta: JpegShotMeta): Uint8Array {
  const make = ascii(meta.make);
  const model = ascii(meta.model);
  const software = ascii(meta.software);
  const stamp = meta.when;
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = ascii(`${stamp.getUTCFullYear()}:${pad(stamp.getUTCMonth() + 1)}:${pad(stamp.getUTCDate())} ${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}:${pad(stamp.getUTCSeconds())}`);
  const exposure = rational(1 / meta.exposureDen);
  const focal = rational(meta.focalMm);
  const xy = new Uint8Array(8);
  const xyView = new DataView(xy.buffer);
  xyView.setUint32(0, 72, true);
  xyView.setUint32(4, 1, true);
  const exposureBytes = new Uint8Array(8);
  const exposureView = new DataView(exposureBytes.buffer);
  exposureView.setUint32(0, exposure[0], true);
  exposureView.setUint32(4, exposure[1], true);
  const focalBytes = new Uint8Array(8);
  const focalView = new DataView(focalBytes.buffer);
  focalView.setUint32(0, focal[0], true);
  focalView.setUint32(4, focal[1], true);
  const header = 8;
  const ifd0Count = 9;
  const exifCount = 5;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifSize = 2 + exifCount * 12 + 4;
  const dataStart = header + ifd0Size + exifSize;
  const long = (bytes: Uint8Array): TiffEntry["bytes"] => bytes;
  const ifd0 = writeIfd([
    { tag: 0x010f, type: 2, count: make.length, bytes: long(make) },
    { tag: 0x0110, type: 2, count: model.length, bytes: long(model) },
    { tag: 0x0112, type: 3, count: 1, inline: 1 },
    { tag: 0x011a, type: 5, count: 1, bytes: xy },
    { tag: 0x011b, type: 5, count: 1, bytes: xy },
    { tag: 0x0128, type: 3, count: 1, inline: 2 },
    { tag: 0x0131, type: 2, count: software.length, bytes: long(software) },
    { tag: 0x0132, type: 2, count: date.length, bytes: long(date) },
    { tag: 0x8769, type: 4, count: 1, inline: header + ifd0Size },
  ], dataStart);
  const exif = writeIfd([
    { tag: 0x829a, type: 5, count: 1, bytes: exposureBytes },
    { tag: 0x920a, type: 5, count: 1, bytes: focalBytes },
    { tag: 0xa002, type: 4, count: 1, inline: meta.width },
    { tag: 0xa003, type: 4, count: 1, inline: meta.height },
    { tag: 0xa405, type: 3, count: 1, inline: Math.round(meta.focal35mm) },
  ], dataStart + ifd0.data.length);
  const tiff = new Uint8Array(dataStart + ifd0.data.length + exif.data.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  tiff.set(ifd0.ifd, header);
  tiff.set(exif.ifd, header + ifd0Size);
  tiff.set(ifd0.data, dataStart);
  tiff.set(exif.data, dataStart + ifd0.data.length);
  const prefix = ascii("Exif").subarray(0, 6);
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  payload.set(tiff, 6);
  void prefix;
  return payload;
}

function xmp(meta: JpegShotMeta): Uint8Array {
  const n = (value: number) => value.toFixed(4);
  const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:drone-dji="${meta.xmpNamespace.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"
    drone-dji:FlightYawDegree="${n(meta.yawDeg)}"
    drone-dji:FlightPitchDegree="${n(meta.pitchDeg)}"
    drone-dji:FlightRollDegree="${n(meta.rollDeg)}"
    drone-dji:GimbalYawDegree="${n(meta.gimbalYawDeg ?? meta.yawDeg)}"
    drone-dji:GimbalPitchDegree="${n(meta.gimbalPitchDeg)}"
    drone-dji:GimbalRollDegree="${n(meta.gimbalRollDeg ?? 0)}"
    drone-dji:RelativeAltitude="${n(meta.aglM)}"
    drone-dji:AbsoluteAltitude="${n(meta.mslM)}"
    drone-dji:CalibratedFocalLength="${n(meta.focalPx)}"
    drone-dji:CalibratedOpticalCenterX="${n(meta.width / 2)}"
    drone-dji:CalibratedOpticalCenterY="${n(meta.height / 2)}"
    drone-dji:CaptureScale="${meta.scale}"
    drone-dji:ImageSource="0SFS"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const header = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
  const body = new TextEncoder().encode(packet);
  const payload = new Uint8Array(header.length + body.length);
  payload.set(header, 0);
  payload.set(body, header.length);
  return payload;
}

/** Inserts EXIF and DJI XMP immediately after the JPEG start of image. */
export function insertJpegMetadata(jpeg: Uint8Array, meta: JpegShotMeta): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("JPEG is missing its start of image.");
  const exif = app1(exifPayload(meta));
  const xmpSegment = app1(xmp(meta));
  const out = new Uint8Array(2 + exif.length + xmpSegment.length + jpeg.length - 2);
  out[0] = 0xff;
  out[1] = 0xd8;
  out.set(exif, 2);
  out.set(xmpSegment, 2 + exif.length);
  out.set(jpeg.subarray(2), 2 + exif.length + xmpSegment.length);
  return out;
}
