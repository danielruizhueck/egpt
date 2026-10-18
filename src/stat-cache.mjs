// stat-cache.mjs — a file's parsed value, re-read only when the file changed (operator 2026-10-18:
// "an in-memory copy works if the files haven't changed").
//
// Change = a different stat stamp (mtime, size, inode). A file's mtime moves in clock ticks
// (~1-16 ms on Windows), so a second write in the tick of the first could keep the stamp: a value
// read within RACY_MS of the file's mtime is not trusted and the next read re-reads it (git's
// "racily clean" rule). Our own writes go in with put() and are trusted at once.
// Stat first, then read: a change between the two re-reads next time, never hides.
import { stat as fsStat, readFile as fsReadFile } from 'node:fs/promises';
import { statSync as fsStatSync, readFileSync as fsReadFileSync } from 'node:fs';

export const RACY_MS = 1000;

const stampOf = (s) => (s ? `${s.mtimeMs}:${s.size}:${s.ino}` : 'absent');

export function createStatCache({ io = {}, now = () => Date.now() } = {}) {
  const stat = io.stat ?? fsStat;
  const readFile = io.readFile ?? fsReadFile;
  const statSync = io.statSync ?? fsStatSync;
  const readFileSync = io.readFileSync ?? fsReadFileSync;
  const memo = new Map();   // path -> { stamp, value, parse, trusted }

  const absentOk = (e) => { if (e?.code === 'ENOENT') return null; throw e; };
  function hit(path, s, parse) {
    const m = memo.get(path);
    return (m && m.trusted && m.parse === parse && m.stamp === stampOf(s)) ? m : null;
  }
  function keep(path, s, value, parse, own = false) {
    memo.set(path, { stamp: stampOf(s), value, parse, trusted: own || !s || now() - s.mtimeMs > RACY_MS });
    return value;
  }

  return {
    /** parse(text | null when absent) → value; a throw is not kept. */
    async read(path, parse) {
      const s = await stat(path).catch(absentOk);
      const m = hit(path, s, parse);
      if (m) return m.value;
      const text = s ? await readFile(path, 'utf8').catch(absentOk) : null;
      return keep(path, s, parse(text), parse);
    },
    readSync(path, parse) {
      let s; try { s = statSync(path); } catch (e) { s = absentOk(e); }
      const m = hit(path, s, parse);
      if (m) return m.value;
      let text = null;
      if (s) { try { text = readFileSync(path, 'utf8'); } catch (e) { text = absentOk(e); } }
      return keep(path, s, parse(text), parse);
    },
    /** Our own write: `value` is what parse would make of it, `s` the written file's stat. */
    put(path, s, value, parse) { keep(path, s, value, parse, true); },
    forget(path) { memo.delete(path); },
  };
}

// The process's one cache — every reader of a given file shares it.
export const statCache = createStatCache();
