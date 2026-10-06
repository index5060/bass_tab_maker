/**
 * One song, one file — the only backup that survives clearing browser data.
 *
 * Container layout, chosen so it needs no zip dependency and stays streamable:
 *
 *   "BPRC1"                5 bytes, magic
 *   uint32 LE              byte length of the JSON header
 *   JSON header            the song's metadata, with binary parts replaced by
 *                          {__blob: index} references
 *   raw bytes              every binary part, back to back, in header order
 *
 * The header lists each part's offset and length, so decoding is a slice per part with no
 * base64 in sight — a 86MB song exports as an 86MB file rather than a 115MB one.
 */

import type { PracticeDoc, StemSet } from './types';

const MAGIC = 'BPRC1';
const MAGIC_BYTES = 5;
const LENGTH_BYTES = 4;
export const SONG_FILE_EXTENSION = '.bassprac';

interface PartRef {
  __blob: number;
}

interface PartEntry {
  offset: number;
  length: number;
  type: string;
}

interface FileHeader {
  version: 1;
  exportedAt: number;
  parts: PartEntry[];
  /** The doc with every binary field replaced by a PartRef. */
  doc: Record<string, unknown>;
}

function isPartRef(v: unknown): v is PartRef {
  return typeof v === 'object' && v !== null && typeof (v as PartRef).__blob === 'number';
}

/* ---------------------------------------------------------------- encode */

export async function encodeSongFile(doc: PracticeDoc): Promise<Blob> {
  // Typed with an explicit ArrayBuffer: BlobPart will not take an ArrayBufferLike-backed view.
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const entries: PartEntry[] = [];
  let offset = 0;

  const addPart = async (data: Blob | ArrayBuffer, type: string): Promise<PartRef> => {
    const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    parts.push(bytes);
    entries.push({ offset, length: bytes.byteLength, type });
    offset += bytes.byteLength;
    return { __blob: entries.length - 1 };
  };

  const shallow: Record<string, unknown> = { ...doc };

  // Guitar Pro scores are bytes; alphaTex scores are text and ride along in the JSON.
  if (doc.scoreKind === 'gp' && doc.scoreData instanceof ArrayBuffer) {
    shallow.scoreData = await addPart(doc.scoreData, 'application/octet-stream');
  }
  if (doc.audioBlob) {
    shallow.audioBlob = await addPart(doc.audioBlob, doc.audioBlob.type || 'audio/mpeg');
  }
  if (doc.stems) {
    shallow.stems = {
      ...doc.stems,
      bass: await addPart(doc.stems.bass, 'audio/wav'),
      minusBass: await addPart(doc.stems.minusBass, 'audio/wav'),
    };
  }

  const header: FileHeader = {
    version: 1,
    exportedAt: Date.now(),
    parts: entries,
    doc: shallow,
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(MAGIC_BYTES + LENGTH_BYTES);
  prefix.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(prefix.buffer).setUint32(MAGIC_BYTES, headerBytes.byteLength, true);

  return new Blob([prefix, headerBytes, ...parts], { type: 'application/octet-stream' });
}

/* ---------------------------------------------------------------- decode */

export async function decodeSongFile(file: Blob): Promise<PracticeDoc> {
  const head = new Uint8Array(await file.slice(0, MAGIC_BYTES + LENGTH_BYTES).arrayBuffer());
  if (head.byteLength < MAGIC_BYTES + LENGTH_BYTES) {
    throw new Error('파일이 너무 짧습니다. 곡 백업 파일이 아닙니다.');
  }
  if (new TextDecoder().decode(head.slice(0, MAGIC_BYTES)) !== MAGIC) {
    throw new Error('곡 백업 파일이 아닙니다.');
  }

  const headerLength = new DataView(head.buffer).getUint32(MAGIC_BYTES, true);
  const headerStart = MAGIC_BYTES + LENGTH_BYTES;
  const bodyStart = headerStart + headerLength;

  const headerText = new TextDecoder().decode(
    await file.slice(headerStart, bodyStart).arrayBuffer(),
  );
  let header: FileHeader;
  try {
    header = JSON.parse(headerText) as FileHeader;
  } catch {
    throw new Error('백업 파일의 헤더가 손상됐습니다.');
  }
  if (header.version !== 1) {
    throw new Error(`지원하지 않는 백업 버전입니다: ${header.version}`);
  }

  const sliceFor = (ref: PartRef): Blob => {
    const entry = header.parts[ref.__blob];
    if (!entry) throw new Error('백업 파일의 조각 참조가 깨졌습니다.');
    const start = bodyStart + entry.offset;
    return file.slice(start, start + entry.length, entry.type);
  };

  const raw = header.doc;
  const doc = { ...raw } as unknown as PracticeDoc;

  if (isPartRef(raw.scoreData)) {
    doc.scoreData = await sliceFor(raw.scoreData).arrayBuffer();
  }
  if (isPartRef(raw.audioBlob)) {
    doc.audioBlob = sliceFor(raw.audioBlob);
  }
  const stems = raw.stems as (Omit<StemSet, 'bass' | 'minusBass'> & {
    bass: unknown;
    minusBass: unknown;
  }) | undefined;
  if (stems && isPartRef(stems.bass) && isPartRef(stems.minusBass)) {
    doc.stems = { ...stems, bass: sliceFor(stems.bass), minusBass: sliceFor(stems.minusBass) };
  }

  if (!doc.id || !doc.scoreKind) throw new Error('백업 파일에 곡 정보가 없습니다.');
  return doc;
}

/** A filename that is safe on Windows and still recognisable. */
export function songFileName(doc: PracticeDoc): string {
  const base = (doc.title || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim();
  return `${base || 'song'}${SONG_FILE_EXTENSION}`;
}
