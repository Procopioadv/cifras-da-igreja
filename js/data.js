const DB_KEY = 'cifras_db_v1';

function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function _activeRepId() {
  try { return JSON.parse(localStorage.getItem(DB_KEY))?.activeRepId || 'igreja'; }
  catch { return 'igreja'; }
}

function _migrate(d) {
  d.songs = d.songs || [];
  d.setlists = Array.isArray(d.setlists) ? d.setlists : [];
  // Migra formato antigo (setlist único) para setlists múltiplos
  if (d.setlists.length === 0 && Array.isArray(d.setlist) && d.setlist.length > 0) {
    const now = Date.now();
    d.setlists.push({
      id: _uid(),
      name: 'Setlist',
      songIds: d.setlist,
      repId: 'igreja',
      updatedAt: d.setlistUpdatedAt || now,
      createdAt: now
    });
    d.setlistsUpdatedAt = d.setlistUpdatedAt || now;
  }
  delete d.setlist;
  delete d.setlistUpdatedAt;
  if (d.setlists.length > 0 && !d.setlists.some(sl => sl.id === d.activeSetlistId)) {
    d.activeSetlistId = d.setlists[0]?.id || null;
  }
  // Migra para multi-repertório
  if (!Array.isArray(d.repertoires)) {
    d.repertoires = [{ id: 'igreja', name: 'Igreja' }];
  }
  if (!d.activeRepId) d.activeRepId = 'igreja';
  d.songs.forEach(s => { if (!s.repId) s.repId = 'igreja'; });
  d.setlists.forEach(sl => { if (!sl.repId) sl.repId = 'igreja'; });
  return d;
}

function _db() {
  try { return _migrate(JSON.parse(localStorage.getItem(DB_KEY)) || {}); }
  catch { return _migrate({}); }
}

function _save(data) { localStorage.setItem(DB_KEY, JSON.stringify(data)); }

const Songs = {
  all() {
    const repId = _activeRepId();
    return _db().songs.filter(s => s.repId === repId).slice().sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
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
      const newSong = { ...song, id: _uid(), repId: _activeRepId(), createdAt: now, updatedAt: now };
      data.songs.push(newSong);
      _save(data);
      savedId = newSong.id;
    }
    Cloud.pushSave(Songs.get(savedId));
    return savedId;
  },
  markPlayed(id, ts) {
    const data = _db();
    const s = data.songs.find(x => x.id === id);
    if (!s) return;
    s.lastPlayedAt = ts || Date.now();
    s.updatedAt = Date.now();
    _save(data);
    Cloud.pushSave(s);
  },
  markManyPlayed(ids, ts) {
    const data = _db();
    const now = ts || Date.now();
    const changed = [];
    ids.forEach(id => {
      const s = data.songs.find(x => x.id === id);
      if (!s) return;
      s.lastPlayedAt = now;
      s.updatedAt = Date.now();
      changed.push(s);
    });
    _save(data);
    // Envia cada uma para o backend (fila reduz duplicatas por id)
    changed.forEach(s => Cloud.pushSave(s));
    return changed.length;
  },

  delete(id) {
    const data = _db();
    data.songs = data.songs.filter(s => s.id !== id);
    let setlistsChanged = false;
    const now = Date.now();
    data.setlists.forEach(sl => {
      const before = sl.songIds.length;
      sl.songIds = sl.songIds.filter(sid => sid !== id);
      if (sl.songIds.length !== before) { sl.updatedAt = now; setlistsChanged = true; }
    });
    if (setlistsChanged) data.setlistsUpdatedAt = now;
    _save(data);
    Cloud.pushDelete(id);
    if (setlistsChanged) Cloud.pushSetlists(data.setlists, data.setlistsUpdatedAt);
  }
};

// ── CLOUD SYNC (Google Sheets via Apps Script) ─
const Cloud = {
  get url() { return localStorage.getItem('cifras_cloud_url') || ''; },
  setUrl(v) { localStorage.setItem('cifras_cloud_url', v.trim()); },
  isConfigured() { return !!this.url; },

  // Estado: idle | syncing | error | pending
  _state: 'idle',
  get state() {
    if (this._state === 'syncing') return 'syncing';
    if (this._queue().length > 0) return 'pending';
    return this._state;
  },
  pendingCount() { return this._queue().length; },
  _setState(s) {
    this._state = s;
    window.dispatchEvent(new CustomEvent('cloud:status', { detail: this.state }));
  },

  _queue() {
    try { return JSON.parse(localStorage.getItem('cifras_pending_queue') || '[]'); }
    catch { return []; }
  },
  _saveQueue(q) {
    localStorage.setItem('cifras_pending_queue', JSON.stringify(q));
    window.dispatchEvent(new CustomEvent('cloud:status', { detail: this.state }));
  },
  _enqueue(action) {
    const q = this._queue();
    let filtered;
    if (action.type === 'setlists') {
      // Setlists: só a última versão do array importa
      filtered = q.filter(a => a.type !== 'setlists');
    } else {
      // Save/delete: última ação para o mesmo id vence
      const targetId = action.song?.id || action.id;
      filtered = q.filter(a => a.type === 'setlists' || (a.song?.id || a.id) !== targetId);
    }
    filtered.push(action);
    this._saveQueue(filtered);
  },

  async _send(payload) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  },

  async pull() {
    if (!this.url) return { ok: false, reason: 'not-configured' };
    this._setState('syncing');
    try {
      const res = await fetch(this.url, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.songs)) {
        this._setState('error');
        return { ok: false, reason: 'bad-response' };
      }

      // Merge por id: quem tem updatedAt mais recente vence.
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

      // Merge dos setlists múltiplos: quem tem setlistsUpdatedAt maior vence (array inteiro)
      const cloudSetlists = Array.isArray(data.setlists) ? data.setlists : null;
      const cloudSetlistsUpdatedAt = Number(data.setlistsUpdatedAt) || 0;
      const localSetlistsUpdatedAt = Number(local.setlistsUpdatedAt) || 0;
      if (cloudSetlists && cloudSetlistsUpdatedAt > localSetlistsUpdatedAt) {
        local.setlists = cloudSetlists;
        local.setlistsUpdatedAt = cloudSetlistsUpdatedAt;
        if (!local.setlists.some(sl => sl.id === local.activeSetlistId)) {
          local.activeSetlistId = local.setlists[0]?.id || null;
        }
      } else if (localSetlistsUpdatedAt > cloudSetlistsUpdatedAt) {
        Cloud._enqueue({ type: 'setlists', setlists: local.setlists, updatedAt: localSetlistsUpdatedAt });
      }

      _save(local);
      toPush.forEach(song => Cloud._enqueue({ type: 'save', song }));

      const flush = await this.flushQueue();
      this._setState(flush.remaining > 0 ? 'error' : 'idle');
      return { ok: true, count: merged.length, pushed: toPush.length };
    } catch(e) {
      this._setState('error');
      return { ok: false, reason: e.message };
    }
  },

  async pushSave(song) {
    if (!this.url || !song) return;
    this._setState('syncing');
    try {
      await this._send({ action: 'save', song });
      this._setState(this._queue().length ? 'pending' : 'idle');
    } catch(e) {
      this._enqueue({ type: 'save', song });
      this._setState('error');
    }
  },

  async pushDelete(id) {
    if (!this.url) return;
    this._setState('syncing');
    try {
      await this._send({ action: 'delete', id });
      this._setState(this._queue().length ? 'pending' : 'idle');
    } catch(e) {
      this._enqueue({ type: 'delete', id });
      this._setState('error');
    }
  },

  async backup() {
    if (!this.url) return { ok: false, reason: 'not-configured' };
    const data = JSON.parse(Storage.export());
    try {
      const res = await this._send({ action: 'backup', data });
      return await res.json();
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  },

  async pushSetlists(setlists, updatedAt) {
    if (!this.url) return;
    this._setState('syncing');
    try {
      await this._send({ action: 'setlists', setlists, updatedAt });
      this._setState(this._queue().length ? 'pending' : 'idle');
    } catch(e) {
      this._enqueue({ type: 'setlists', setlists, updatedAt });
      this._setState('error');
    }
  },

  async flushQueue() {
    if (!this.url) return { ok: false, remaining: 0 };
    const q = this._queue();
    if (q.length === 0) return { ok: true, sent: 0, remaining: 0 };

    const remaining = [];
    let sent = 0;
    for (const action of q) {
      try {
        let payload;
        if (action.type === 'save')    payload = { action: 'save', song: action.song };
        else if (action.type === 'delete')   payload = { action: 'delete', id: action.id };
        else if (action.type === 'setlists') payload = { action: 'setlists', setlists: action.setlists, updatedAt: action.updatedAt };
        await this._send(payload);
        sent++;
      } catch {
        remaining.push(action);
      }
    }
    this._saveQueue(remaining);
    return { ok: remaining.length === 0, sent, remaining: remaining.length };
  }
};

// Reenvia pendências assim que voltar a ficar online
window.addEventListener('online', () => {
  if (Cloud.isConfigured()) Cloud.flushQueue();
});

const Setlist = {
  all() {
    const repId = _activeRepId();
    return _db().setlists.filter(sl => (sl.repId || 'igreja') === repId);
  },
  activeId() {
    const repId = _activeRepId();
    const data = _db();
    const repSetlists = data.setlists.filter(sl => (sl.repId || 'igreja') === repId);
    if (repSetlists.some(sl => sl.id === data.activeSetlistId)) return data.activeSetlistId;
    return repSetlists[0]?.id || null;
  },
  active() {
    const id = this.activeId();
    if (!id) return null;
    return _db().setlists.find(sl => sl.id === id) || null;
  },
  setActive(id) {
    const data = _db();
    if (!data.setlists.some(sl => sl.id === id)) return;
    data.activeSetlistId = id;
    _save(data);
  },

  create(name) {
    const data = _db();
    const now = Date.now();
    const sl = { id: _uid(), name: (name || 'Setlist').trim() || 'Setlist', songIds: [], repId: _activeRepId(), updatedAt: now, createdAt: now };
    data.setlists.push(sl);
    data.activeSetlistId = sl.id;
    data.setlistsUpdatedAt = now;
    _save(data);
    Cloud.pushSetlists(data.setlists, data.setlistsUpdatedAt);
    return sl.id;
  },
  rename(id, name) {
    const data = _db();
    const sl = data.setlists.find(s => s.id === id);
    if (!sl) return;
    sl.name = (name || '').trim() || sl.name;
    sl.updatedAt = Date.now();
    data.setlistsUpdatedAt = sl.updatedAt;
    _save(data);
    Cloud.pushSetlists(data.setlists, data.setlistsUpdatedAt);
  },
  delete(id) {
    const data = _db();
    data.setlists = data.setlists.filter(s => s.id !== id);
    if (data.activeSetlistId === id) {
      data.activeSetlistId = data.setlists[0]?.id || null;
    }
    data.setlistsUpdatedAt = Date.now();
    _save(data);
    Cloud.pushSetlists(data.setlists, data.setlistsUpdatedAt);
  },

  // Ações sobre o setlist ativo
  ids() { return this.active()?.songIds || []; },
  get() { return this.ids().map(id => Songs.get(id)).filter(Boolean); },
  has(id) { return this.ids().includes(id); },

  _mutateActive(fn) {
    const data = _db();
    let sl = data.setlists.find(s => s.id === data.activeSetlistId);
    // Se não tem setlist ativo, cria um padrão sob demanda
    if (!sl) {
      const now = Date.now();
      sl = { id: _uid(), name: 'Setlist', songIds: [], repId: _activeRepId(), updatedAt: now, createdAt: now };
      data.setlists.push(sl);
      data.activeSetlistId = sl.id;
    }
    sl.songIds = fn(sl.songIds);
    sl.updatedAt = Date.now();
    data.setlistsUpdatedAt = sl.updatedAt;
    _save(data);
    Cloud.pushSetlists(data.setlists, data.setlistsUpdatedAt);
  },

  add(songId) { this._mutateActive(list => list.includes(songId) ? list : [...list, songId]); },
  remove(songId) { this._mutateActive(list => list.filter(sid => sid !== songId)); },
  move(from, to) {
    this._mutateActive(list => {
      const arr = [...list];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      return arr;
    });
  },
  reorder(newIds) { this._mutateActive(() => newIds); },
  clear() { this._mutateActive(() => []); }
};

// ── TEMA (light / dark / auto) ────────────────
const Theme = {
  get() { return localStorage.getItem('cifras_theme') || 'auto'; },
  set(mode) {
    localStorage.setItem('cifras_theme', mode);
    this.apply();
  },
  apply() {
    const mode = this.get();
    const root = document.documentElement;
    if (mode === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', mode);
    }
    // Atualiza a barra de status do celular pra combinar
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      meta.setAttribute('content', dark ? '#1e293b' : '#4338ca');
    }
  }
};

const Repertoire = {
  all() { return _db().repertoires || [{ id: 'igreja', name: 'Igreja' }]; },
  activeId() { return _db().activeRepId || 'igreja'; },
  setActive(id) {
    const data = _db();
    data.activeRepId = id;
    _save(data);
  },
  add(name) {
    const data = _db();
    const rep = { id: _uid(), name: name.trim() };
    data.repertoires = data.repertoires || [{ id: 'igreja', name: 'Igreja' }];
    data.repertoires.push(rep);
    _save(data);
    return rep.id;
  },
  rename(id, name) {
    const data = _db();
    const rep = (data.repertoires || []).find(r => r.id === id);
    if (rep) { rep.name = name.trim(); _save(data); }
  },
  songCount(id) {
    return _db().songs.filter(s => s.repId === id).length;
  },
  delete(id) {
    if (id === 'igreja') return;
    const data = _db();
    data.repertoires = (data.repertoires || []).filter(r => r.id !== id);
    data.songs = data.songs.filter(s => s.repId !== id);
    data.setlists = data.setlists.filter(sl => sl.repId !== id);
    if (data.activeRepId === id) data.activeRepId = 'igreja';
    _save(data);
  }
};

const Storage = {
  export() { return JSON.stringify(_db(), null, 2); },
  import(json) {
    try {
      const d = JSON.parse(json);
      if (!Array.isArray(d.songs)) throw new Error('invalid');
      _save(_migrate(d));
      return true;
    } catch { return false; }
  },
  deduplicate() {
    const data = _db();
    const seen = new Map();
    for (const song of data.songs) {
      const key = song.title.trim().toLowerCase();
      const existing = seen.get(key);
      if (!existing || (Number(song.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) {
        seen.set(key, song);
      }
    }
    const before = data.songs.length;
    data.songs = [...seen.values()];
    _save(data);
    return before - data.songs.length;
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
