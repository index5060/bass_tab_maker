/**
 * Local persistence. Everything lives in IndexedDB in the browser — no server, no upload.
 *
 * Metadata and blobs are kept in SEPARATE stores, which is the whole point of this file.
 *
 * The first version put the audio and both stems inline in the song record, so listing the
 * library — a list of titles — deserialised every byte of every song. With one separated
 * song that is ~86MB read on every autosave, and the autosave runs on every slider drag.
 * Splitting them means the list touches a few kilobytes and the heavy data is only read when
 * a song is actually opened.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PracticeDoc, StemSet } from './types';

/** A song without its heavy parts — enough to render the library and pick what to open. */
export type SongMeta = Omit<PracticeDoc, 'audioBlob' | 'stems'> & {
  hasAudio: boolean;
  hasStems: boolean;
  /** Bytes of audio + stems, so the UI can show what a song costs. */
  assetBytes: number;
};

interface SongAssets {
  id: string;
  audioBlob?: Blob;
  stems?: StemSet;
}

interface BassDB extends DBSchema {
  songs: {
    key: string;
    value: SongMeta;
    indexes: { updatedAt: number };
  };
  assets: {
    key: string;
    value: SongAssets;
  };
}

const DB_NAME = 'bass-practice';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<BassDB>> | null = null;

function db(): Promise<IDBPDatabase<BassDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BassDB>(DB_NAME, DB_VERSION, {
      async upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const store = database.createObjectStore('songs', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (oldVersion < 2) {
          database.createObjectStore('assets', { keyPath: 'id' });

          // Move blobs out of any v1 records rather than leaving them to bloat every list.
          const songs = tx.objectStore('songs');
          const assets = tx.objectStore('assets');
          let cursor = await songs.openCursor();
          while (cursor) {
            const legacy = cursor.value as unknown as PracticeDoc & Partial<SongMeta>;
            const audioBlob = legacy.audioBlob;
            const stems = legacy.stems;
            if (audioBlob || stems) {
              await assets.put({ id: legacy.id, audioBlob, stems });
            }
            await cursor.update(toMeta({ ...legacy, audioBlob, stems } as PracticeDoc));
            cursor = await cursor.continue();
          }
        }
      },
    });
  }
  return dbPromise;
}

function assetBytesOf(doc: PracticeDoc): number {
  return (doc.audioBlob?.size ?? 0) + (doc.stems ? doc.stems.bass.size + doc.stems.minusBass.size : 0);
}

function toMeta(doc: PracticeDoc): SongMeta {
  const { audioBlob, stems, ...rest } = doc;
  return {
    ...rest,
    hasAudio: !!audioBlob,
    hasStems: !!stems,
    assetBytes: assetBytesOf(doc),
  };
}

/* ------------------------------------------------------------------ reads */

/** Metadata only. Safe to call on every save. */
export async function listSongs(): Promise<SongMeta[]> {
  const d = await db();
  const all = await d.getAllFromIndex('songs', 'updatedAt');
  return all.reverse();
}

/** The full song, blobs included. */
export async function getSong(id: string): Promise<PracticeDoc | undefined> {
  const d = await db();
  const meta = await d.get('songs', id);
  if (!meta) return undefined;
  const assets = await d.get('assets', id);
  const { hasAudio: _a, hasStems: _s, assetBytes: _b, ...rest } = meta;
  return { ...rest, audioBlob: assets?.audioBlob, stems: assets?.stems };
}

/* ----------------------------------------------------------------- writes */

export async function saveSong(doc: PracticeDoc): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'assets'], 'readwrite');
  const stamped = { ...doc, updatedAt: Date.now() };
  await Promise.all([
    tx.objectStore('songs').put(toMeta(stamped)),
    doc.audioBlob || doc.stems
      ? tx.objectStore('assets').put({ id: doc.id, audioBlob: doc.audioBlob, stems: doc.stems })
      : tx.objectStore('assets').delete(doc.id),
    tx.done,
  ]);
}

export async function deleteSong(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'assets'], 'readwrite');
  await Promise.all([
    tx.objectStore('songs').delete(id),
    tx.objectStore('assets').delete(id),
    tx.done,
  ]);
}

/**
 * Remove untouched copies of the starter song.
 *
 * Cleans up the mess left by the old behaviour, where the starter took a new random id on
 * every load and piled up a duplicate per session. Only rows with nothing of the user's in
 * them are removed — no audio, no stems, no anchors, no bookmarks — so this can never throw
 * away real work.
 */
/**
 * Turn a starter-song record into a real song, or drop it if it is untouched.
 *
 * The starter used to be a library song with a fixed id, so attaching your own recording to
 * it filed that recording — and, after five minutes of separation, 85MB of stems — under
 * "Warm-up: Position Shifts". The starter is a template now and is never saved, but anyone
 * upgrading already has a record sitting on that id with real work inside it.
 *
 * Re-keying rather than deleting is the whole point here: that row may be the only copy of a
 * separation that took minutes to produce.
 */
export async function rescueDemoRecord(
  demoId: string,
): Promise<{ rescuedId: string; title: string } | null> {
  const d = await db();
  const meta = await d.get('songs', demoId);
  if (!meta) return null;

  const assets = await d.get('assets', demoId);
  const untouched =
    !assets?.audioBlob &&
    !assets?.stems &&
    (meta.syncAnchors?.length ?? 0) === 0 &&
    (meta.bookmarks?.length ?? 0) === 0;

  if (untouched) {
    await deleteSong(demoId);
    return null;
  }

  const rescuedId = crypto.randomUUID();
  // Name it after the audio if we can; the starter's exercise title means nothing here.
  const title = meta.audioFileName?.replace(/\.[^.]+$/, '') || '이름 없는 곡';

  const tx = d.transaction(['songs', 'assets'], 'readwrite');
  await Promise.all([
    tx.objectStore('songs').put({ ...meta, id: rescuedId, title, updatedAt: Date.now() }),
    assets ? tx.objectStore('assets').put({ ...assets, id: rescuedId }) : Promise.resolve(),
    tx.done,
  ]);
  await deleteSong(demoId);

  return { rescuedId, title };
}

export async function purgeEmptyDemos(demoScoreData: string, keepId: string): Promise<number> {
  const d = await db();
  const all = await d.getAll('songs');
  const junk = all.filter(
    (s) =>
      s.id !== keepId &&
      s.scoreKind === 'alphatex' &&
      s.scoreData === demoScoreData &&
      !s.hasAudio &&
      !s.hasStems &&
      (s.syncAnchors?.length ?? 0) === 0 &&
      (s.bookmarks?.length ?? 0) === 0,
  );
  for (const s of junk) await deleteSong(s.id);
  return junk.length;
}

/* -------------------------------------------------------------- quota etc */

export interface StorageStatus {
  /** True when the browser promised not to evict this origin under disk pressure. */
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
}

/**
 * Ask the browser to keep this data.
 *
 * Without it, IndexedDB is "best effort" and can be cleared when the disk gets tight — which
 * for this app means losing a 172MB model's worth of work per song. Chrome usually grants it
 * silently for a site with engagement; a refusal is not an error, just a fact worth showing.
 */
export async function requestPersistentStorage(): Promise<StorageStatus> {
  let persisted = false;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
    if (!persisted) persisted = (await navigator.storage?.persist?.()) ?? false;
  } catch {
    persisted = false;
  }
  return { persisted, ...(await estimateStorage()) };
}

export async function estimateStorage(): Promise<{ usageBytes: number; quotaBytes: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usageBytes: e?.usage ?? 0, quotaBytes: e?.quota ?? 0 };
  } catch {
    return { usageBytes: 0, quotaBytes: 0 };
  }
}

/* ------------------------------------------------------------ save queue */

/**
 * Debounced save — the practice sidecar changes on every slider drag and we do not want a
 * write per frame.
 *
 * `onError` matters more than it looks: this used to be an un-caught async call fired from
 * a timer, so a rejected write (quota, aborted transaction) vanished as an unhandled
 * rejection. The song silently failed to save and nothing on screen said so.
 */
export function createSongSaver(
  delayMs = 600,
  onSaved?: (doc: PracticeDoc) => void,
  onError?: (error: Error) => void,
) {
  let timer: number | undefined;
  let pending: PracticeDoc | null = null;

  const flush = async () => {
    timer = undefined;
    if (!pending) return;
    const doc = pending;
    pending = null;
    try {
      await saveSong(doc);
      onSaved?.(doc);
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };

  return {
    queue(doc: PracticeDoc) {
      pending = doc;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void flush(), delayMs);
    },
    async flushNow() {
      if (timer !== undefined) window.clearTimeout(timer);
      await flush();
    },
  };
}
