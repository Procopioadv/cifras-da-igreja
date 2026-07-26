// Regex que detecta se uma palavra é um acorde
const CHORD_RE = /^[A-G][#b]?(m|maj|min|aug|dim|sus)?(\d+)?([#b]\d+)?(\/[A-G][#b]?)?$/;

function isChordWord(w) { return CHORD_RE.test(w); }

function isChordOnlyLine(line) {
  const words = line.trim().split(/\s+/);
  return words.length > 0 && words.every(isChordWord);
}

// Converte formato Cifra Club (acordes em linha separada acima da letra)
// para o formato de colchetes usado pelo app: [C]palavra [G]outra
function convertCifraClub(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1];

    if (isChordOnlyLine(line) && next !== undefined && !isChordOnlyLine(next)) {
      // Combina linha de acordes com linha de letra
      out.push(mergeChordAndLyric(line, next));
      i += 2;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

function mergeChordAndLyric(chordLine, lyricLine) {
  const chords = [];
  const re = /(\S+)/g;
  let m;
  while ((m = re.exec(chordLine)) !== null) {
    chords.push({ chord: m[1], pos: m.index });
  }
  if (chords.length === 0) return lyricLine;

  let result = '';
  let lyricIdx = 0;

  for (let ci = 0; ci < chords.length; ci++) {
    const { chord, pos } = chords[ci];
    const nextPos = ci + 1 < chords.length ? chords[ci + 1].pos : Infinity;

    // Avança a letra até a posição do acorde
    if (pos > lyricIdx) {
      result += lyricLine.slice(lyricIdx, Math.min(pos, lyricLine.length));
      lyricIdx = Math.min(pos, lyricLine.length);
    }

    // Insere [acorde] e inclui letra até a próxima cifra
    const lyricEnd = Math.min(nextPos, lyricLine.length);
    const lyricChunk = lyricLine.slice(lyricIdx, lyricEnd);
    result += `[${chord}]${lyricChunk}`;
    lyricIdx = lyricEnd;
  }

  // Letra restante
  if (lyricIdx < lyricLine.length) {
    result += lyricLine.slice(lyricIdx);
  }

  return result;
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function noteIndex(note) {
  const si = SHARP.indexOf(note);
  return si !== -1 ? si : FLAT.indexOf(note);
}

function shiftNote(note, n, useFlats) {
  const i = noteIndex(note);
  if (i === -1) return note;
  const j = ((i + n) % 12 + 12) % 12;
  return (useFlats ? FLAT : SHARP)[j];
}

function shiftChord(chord, n, useFlats) {
  return chord
    .replace(/^([A-G][#b]?)/, (_, root) => shiftNote(root, n, useFlats))
    .replace(/\/([A-G][#b]?)/, (_, bass) => '/' + shiftNote(bass, n, useFlats));
}

function transposeContent(text, semitones, useFlats) {
  if (semitones === 0) return text;
  return text.replace(/\[([^\]]+)\]/g, (_, chord) => '[' + shiftChord(chord, semitones, useFlats) + ']');
}

function detectFlats(text) {
  const f = (text.match(/\[[^\]]*b[^\]]*\]/g) || []).length;
  const s = (text.match(/\[[^\]]*#[^\]]*\]/g) || []).length;
  return f > s;
}

function displayKey(key, semitones) {
  if (!key) return '';
  const i = noteIndex(key);
  if (i === -1) return key;
  const j = ((i + semitones) % 12 + 12) % 12;
  return SHARP[j];
}
