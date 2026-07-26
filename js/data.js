const DB_KEY = 'cifras_db_v1';

function _db() {
  try { return JSON.parse(localStorage.getItem(DB_KEY)) || { songs: [], setlist: [] }; }
  catch { return { songs: [], setlist: [] }; }
}

function _save(data) { localStorage.setItem(DB_KEY, JSON.stringify(data)); }

function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const Songs = {
  all() {
    return _db().songs.slice().sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  },
  get(id) {
    return _db().songs.find(s => s.id === id) || null;
  },
  save(song) {
    const data = _db();
    const now = Date.now();
    let savedId;
    if (song.id) {
      const i = data.songs.findIndex(s => s.id === song.id);
      if (i >= 0) data.songs[i] = { ...song, updatedAt: now };
      else data.songs.push({ ...song, updatedAt: now });
      _save(data);
      savedId = song.id;
    } else {
      const newSong = { ...song, id: _uid(), createdAt: now, updatedAt: now };
      data.songs.push(newSong);
      _save(data);
      savedId = newSong.id;
    }
    Cloud.pushSave(Songs.get(savedId));
    return savedId;
  },
  delete(id) {
    const data = _db();
    data.songs = data.songs.filter(s => s.id !== id);
    data.setlist = (data.setlist || []).filter(sid => sid !== id);
    _save(data);
    Cloud.pushDelete(id);
  }
};

// ── CLOUD SYNC (Google Sheets via Apps Script) ─
const Cloud = {
  get url() { return localStorage.getItem('cifras_cloud_url') || ''; },
  setUrl(v) { localStorage.setItem('cifras_cloud_url', v.trim()); },
  isConfigured() { return !!this.url; },

  async pull() {
    if (!this.url) return { ok: false, reason: 'not-configured' };
    try {
      const res = await fetch(this.url, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.songs)) return { ok: false, reason: 'bad-response' };

      // Merge por id: quem tem updatedAt mais recente vence.
      // Músicas só locais são preservadas e reenviadas para a nuvem.
      const local = _db();
      const localById = new Map(local.songs.map(s => [s.id, s]));
      const cloudById = new Map(data.songs.map(s => [s.id, s]));
      const merged = [];
      const toPush = [];

      const allIds = new Set([...localById.keys(), ...cloudById.keys()]);
      for (const id of allIds) {
        const l = localById.get(id);
        const c = cloudById.get(id);
        if (l && c) {
          const lu = Number(l.updatedAt) || 0;
          const cu = Number(c.updatedAt) || 0;
          if (lu > cu) { merged.push(l); toPush.push(l); }
          else { merged.push(c); }
        } else if (l) {
          merged.push(l);
          toPush.push(l);
        } else {
          merged.push(c);
        }
      }

      local.songs = merged;
      _save(local);
      toPush.forEach(song => Cloud.pushSave(song));

      return { ok: true, count: merged.length, pushed: toPush.length };
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  },

  pushSave(song) {
    if (!this.url || !song) return;
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'save', song })
    }).catch(() => {});
  },

  pushDelete(id) {
    if (!this.url) return;
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete', id })
    }).catch(() => {});
  }
};

const Setlist = {
  ids() { return _db().setlist || []; },
  get() { return this.ids().map(id => Songs.get(id)).filter(Boolean); },
  has(id) { return this.ids().includes(id); },
  add(id) {
    const data = _db();
    if (!(data.setlist || []).includes(id)) {
      data.setlist = [...(data.setlist || []), id];
      _save(data);
    }
  },
  remove(id) {
    const data = _db();
    data.setlist = (data.setlist || []).filter(sid => sid !== id);
    _save(data);
  },
  move(from, to) {
    const data = _db();
    const list = [...(data.setlist || [])];
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    data.setlist = list;
    _save(data);
  },
  clear() {
    const data = _db();
    data.setlist = [];
    _save(data);
  }
};

const Storage = {
  export() { return JSON.stringify(_db(), null, 2); },
  import(json) {
    try {
      const d = JSON.parse(json);
      if (!Array.isArray(d.songs)) throw new Error('invalid');
      _save({ songs: d.songs, setlist: d.setlist || [] });
      return true;
    } catch { return false; }
  }
};

function loadSampleSongs() {
  const samples = [
    {
      title: 'Vós Sois a Luz do Mundo',
      artist: 'Tradicional',
      key: 'C',
      category: 'Entrada',
      content: `[C]Vós sois a [F]luz do [C]mundo
[G]Cidade [Am]forte nos [F]montes [G]posta
[C]Vós sois a [F]luz do [C]mundo
[G]Nenhum a [C]esconde, mas [G]põe-na no [C]alto

[Am]Brilhai, [G]brilhai,
[F]Que veja o [C]mundo vosso amor
[Am]Brilhai, [G]brilhai,
[F]Glorificai ao [G]Senhor`
    },
    {
      title: 'Santo',
      artist: 'Tradicional',
      key: 'G',
      category: 'Santo',
      content: `[G]Santo, [C]Santo, [G]Santo
[D]Senhor, Deus do [G]universo
O [C]céu e a terra estão cheios da vossa [D]glória
[G]Hosana, [C]hosana, [G]hosana nas [D]alturas

[G]Bendito o que [C]vem em nome do [D]Senhor
[G]Hosana, [C]hosana, [G]hosana nas [D]alturas`
    },
    {
      title: 'Cordeiro de Deus',
      artist: 'Tradicional',
      key: 'D',
      category: 'Cordeiro de Deus',
      content: `[D]Cordeiro de [G]Deus que tirais o [A]pecado do [D]mundo
[G]Tende piedade de [A]nós
[D]Cordeiro de [G]Deus que tirais o [A]pecado do [D]mundo
[G]Tende piedade de [A]nós
[D]Cordeiro de [G]Deus que tirais o [A]pecado do [D]mundo
[G]Dai-nos a [A]paz`
    },
    {
      title: 'Glória a Deus nas Alturas',
      artist: 'Tradicional',
      key: 'F',
      category: 'Glória',
      content: `[F]Glória a [Bb]Deus nas al[F]turas
E paz na [C]terra aos homens que ele [F]ama

[F]Senhor [Bb]Deus, Rei dos [F]céus
[C]Deus Pai todo-po[F]deroso
A vós rendi[Bb]mos gra[F]ças
Ben[C]zemos o vosso santo [F]nome

[Bb]Senhor [F]Jesus [C]Cristo
[F]Filho Unigênito
[Bb]Senhor [C]Deus, Cordeiro de [F]Deus
[C]Filho do [F]Pai`
    }
  ];
  samples.forEach(s => Songs.save(s));
}
