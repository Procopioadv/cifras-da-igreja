// ── STATE ─────────────────────────────────────
const state = {
  view: 'repertorio',
  songId: null,
  semitones: 0,
  search: '',
  category: '',
  editSong: null,
  presenting: false,
};

let _wakeLock = null;

// ── AUTO-SCROLL ───────────────────────────────
const AutoScroll = {
  _raf: null,
  _last: 0,
  _acc: 0,
  active: false,
  speed: Number(localStorage.getItem('cifras_scroll_speed')) || 30, // pixels/segundo
  setSpeed(v) {
    this.speed = Math.max(5, Math.min(120, v));
    localStorage.setItem('cifras_scroll_speed', String(this.speed));
  },
  start() {
    if (this.active) return;
    this.active = true;
    this._last = performance.now();
    const step = now => {
      if (!this.active) return;
      const dt = (now - this._last) / 1000;
      this._last = now;
      this._acc += dt * this.speed;
      const px = Math.floor(this._acc);
      if (px > 0) {
        this._acc -= px;
        const before = window.scrollY;
        window.scrollBy(0, px);
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY >= maxScroll - 1 || window.scrollY === before) {
          this.stop();
          return;
        }
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  },
  stop() {
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._acc = 0;
  },
  toggle() { this.active ? this.stop() : this.start(); }
};

// ── UTILS ─────────────────────────────────────
function h(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape para uso em string JS dentro de atributo HTML (onclick="foo('${jsEsc(id)}')")
function jsEsc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function go(view, params) {
  if (state.presenting && view !== 'song') doExitPresent();
  if (view !== 'song') AutoScroll.stop();
  Object.assign(state, params || {}, { view });
  history.pushState({ ...state }, '');
  render();
  window.scrollTo(0, 0);
}

function goBack() {
  const backMap = { song: 'repertorio', edit: state.songId ? 'song' : 'repertorio', settings: 'repertorio' };
  const dest = backMap[state.view] || 'repertorio';
  go(dest);
}

// ── CHORD RENDERER ────────────────────────────
const ChordFormat = {
  get() { return localStorage.getItem('cifras_chord_format') || 'inline'; },
  set(v) { localStorage.setItem('cifras_chord_format', v); },
  toggle() { this.set(this.get() === 'inline' ? 'above' : 'inline'); }
};

function renderContent(rawContent, semitones) {
  const useFlats = detectFlats(rawContent);
  const content = transposeContent(rawContent, semitones, useFlats);
  return ChordFormat.get() === 'above'
    ? renderContentAbove(content)
    : renderContentInline(content);
}

function renderContentInline(content) {
  return content.split('\n').map(line => {
    if (!line.trim() && !line.includes('[')) {
      return '<span class="s-empty"></span>';
    }
    if (!line.includes('[')) {
      return `<span class="s-line">${h(line)}</span>`;
    }

    const parts = line.split(/(\[[^\]]+\])/);
    let html = '';
    for (const part of parts) {
      if (part.startsWith('[') && part.endsWith(']')) {
        const chord = part.slice(1, -1);
        html += `<span class="s-chord">${h(chord)}</span>`;
      } else {
        html += h(part);
      }
    }
    return `<span class="s-line">${html}</span>`;
  }).join('');
}

// Formato tradicional: cifras em linha própria acima da letra, alinhadas por posição
function renderContentAbove(content) {
  return content.split('\n').map(line => {
    if (!line.trim() && !line.includes('[')) {
      return '<span class="s-empty"></span>';
    }
    if (!line.includes('[')) {
      return `<span class="s-line-trad">${h(line) || '&nbsp;'}</span>`;
    }

    // Reconstrói duas linhas: cifras (com espaços onde estava a letra) e letra pura
    let chordRow = '';
    let lyricRow = '';
    const parts = line.split(/(\[[^\]]+\])/);
    for (const part of parts) {
      if (part.startsWith('[') && part.endsWith(']')) {
        const chord = part.slice(1, -1);
        // Se a cifra ficaria em cima de outra cifra, força um espaço para não colar
        if (chordRow.length <= lyricRow.length) {
          chordRow += ' '.repeat(lyricRow.length - chordRow.length) + chord;
        } else {
          chordRow += ' ' + chord;
        }
      } else {
        lyricRow += part;
      }
    }
    // Se a linha da letra é mais curta que a das cifras, completa com espaços para não quebrar layout
    if (lyricRow.length < chordRow.length) {
      lyricRow += ' '.repeat(chordRow.length - lyricRow.length);
    }
    return `<span class="s-chord-row">${h(chordRow).replace(/ /g, '&nbsp;')}</span>` +
           `<span class="s-lyric-row">${h(lyricRow).replace(/ /g, '&nbsp;') || '&nbsp;'}</span>`;
  }).join('');
}

// ── ONLINE SEARCH ─────────────────────────────
const CC_BASE = 'https://www.cifraclub.com.br';
const CC_SKIP = ['busca','tabs','videos','noticias','pro','premium','login','cadastro',
                 'artistas','categorias','cifras-mais','tom','categoria','playlist','afinador'];
const PROXIES = [
  u => fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`).then(r=>r.json()).then(d=>d.contents||''),
  u => fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`).then(r=>{ if(!r.ok) throw new Error(); return r.text(); }),
  u => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`).then(r=>{ if(!r.ok) throw new Error(); return r.text(); })
];

function toTitleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchProxy(url) {
  for (const proxy of PROXIES) {
    try {
      const html = await proxy(url);
      if (html && html.length > 100) return html;
    } catch {}
  }
  throw new Error('Não foi possível conectar. Verifique sua internet.');
}

function parseCifraClubLinks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set();
  const results = [];

  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const full = href.startsWith('http') ? href : CC_BASE + href;
    const m = full.match(/cifraclub\.com\.br\/([^\/\?#]+)\/([^\/\?#]+)\//);
    if (!m) return;

    const artist = m[1], song = m[2];
    if (CC_SKIP.some(s => artist === s || song === s)) return;
    if (artist.length < 2 || song.length < 2) return;

    const key = `${artist}/${song}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      title:  toTitleCase(song.replace(/-/g, ' ')),
      artist: toTitleCase(artist.replace(/-/g, ' ')),
      url:    `${CC_BASE}/${artist}/${song}/`
    });
  });

  return results.slice(0, 20);
}

async function searchCifraClub(query) {
  const html = await fetchProxy(`${CC_BASE}/busca/?q=${encodeURIComponent(query)}&type=cifra`);
  return parseCifraClubLinks(html);
}

async function importCifraClub(url) {
  // Garante que é URL do Cifra Club
  if (!url.includes('cifraclub')) throw new Error('URL inválida');
  const html = await fetchProxy(url);
  const doc  = new DOMParser().parseFromString(html, 'text/html');

  const title  = (doc.querySelector('h1.t1, h1.cifra-title, h1')?.textContent || '').trim();
  const artist = (doc.querySelector('h2.t3 a, .art-name a, h2 a')?.textContent || '').trim();

  const pres = [...doc.querySelectorAll('pre')]
    .sort((a, b) => b.textContent.length - a.textContent.length);
  const raw = (pres[0]?.textContent || '').trim();

  return { title: toTitleCase(title), artist: toTitleCase(artist), content: convertCifraClub(raw) };
}

// ── CATEGORIES ────────────────────────────────
const CATS = [
  'Entrada', 'Ato Penitencial', 'Glória', 'Salmo', 'Aleluia',
  'Ofertório', 'Santo', 'Cordeiro de Deus', 'Comunhão', 'Ação de Graças', 'Outros'
];

const KEYS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B','Db','Eb','Gb','Ab','Bb'];

// ── VIEWS ─────────────────────────────────────

function viewRepertorio() {
  const songs = Songs.all();
  const q = state.search.toLowerCase();
  const cat = state.category;

  const filtered = songs.filter(s => {
    const mq = !q || s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q);
    const mc = !cat || s.category === cat;
    return mq && mc;
  });

  const list = filtered.length
    ? filtered.map(s => `
        <div class="song-item" onclick="go('song',{songId:'${jsEsc(s.id)}',semitones:0})">
          <div class="song-item-body">
            <span class="song-name">${h(s.title)}</span>
            ${s.artist ? `<span class="song-sub">${h(s.artist)}</span>` : ''}
          </div>
          <div class="song-item-right">
            ${s.key ? `<span class="badge badge-key">${h(s.key)}</span>` : ''}
            ${s.category ? `<span class="badge badge-cat">${h(s.category)}</span>` : ''}
          </div>
        </div>`).join('')
    : '<div class="empty-state">Nenhuma música encontrada</div>';

  return `
    <div class="header">
      <h1>Cifras da Igreja</h1>
      ${syncBadgeHTML()}
      <button class="btn-icon" onclick="go('settings')" title="Configurações">&#9881;</button>
    </div>
    <div class="search-bar">
      <input class="search-input" type="search" placeholder="Buscar..." value="${h(state.search)}"
        oninput="state.search=this.value;renderMain()">
      <select class="cat-select" onchange="state.category=this.value;renderMain()">
        <option value="">Todas</option>
        ${CATS.map(c => `<option value="${h(c)}" ${state.category === c ? 'selected' : ''}>${h(c)}</option>`).join('')}
      </select>
    </div>
    <div class="song-list">${list}</div>
    <div class="song-count">${filtered.length} música${filtered.length !== 1 ? 's' : ''}</div>`;
}

function viewSong() {
  const song = Songs.get(state.songId);
  if (!song) return '<div style="padding:2rem;text-align:center;color:#dc2626">Música não encontrada</div>';

  const inSL = Setlist.has(song.id);
  const curKey = song.key ? displayKey(song.key, state.semitones) : '';
  const content = renderContent(song.content || '', state.semitones);
  const tpLabel = state.semitones === 0 ? 'Original' : (state.semitones > 0 ? '+' : '') + state.semitones + ' st';

  return `
    <div class="header">
      <button class="btn-back" onclick="goBack()">&#8592; Voltar</button>
      <h1>${h(song.title)}</h1>
      ${syncBadgeHTML()}
      <button class="btn-icon ${inSL ? 'star-active' : ''}" onclick="toggleSetlist('${jsEsc(song.id)}')" title="${inSL ? 'Remover do setlist' : 'Adicionar ao setlist'}">
        ${inSL ? '&#9733;' : '&#9734;'}
      </button>
      <button class="btn-icon" onclick="doEditCurrentSong()" title="Editar">&#9998;</button>
    </div>

    <div class="song-meta">
      <div class="song-view-title">${h(song.title)}</div>
      ${song.artist ? `<div class="song-view-artist">${h(song.artist)}</div>` : ''}
      <div class="song-badges">
        ${song.category ? `<span class="badge badge-cat">${h(song.category)}</span>` : ''}
        ${curKey ? `<span class="badge badge-key">Tom: ${h(curKey)}</span>` : ''}
        ${song.capo ? `<span class="badge badge-capo">Capo ${song.capo}</span>` : ''}
        ${state.semitones !== 0 ? `<span class="badge badge-tp">${state.semitones > 0 ? '+' : ''}${state.semitones} st</span>` : ''}
      </div>
    </div>

    ${song.notes ? `
    <div class="song-notes">
      <div class="song-notes-label">&#128221; Anotações</div>
      <div class="song-notes-body">${h(song.notes).replace(/\n/g, '<br>')}</div>
    </div>` : ''}

    <div class="transpose-bar">
      <button class="btn-tp" onclick="doTranspose(-2)">-2</button>
      <button class="btn-tp" onclick="doTranspose(-1)">-1</button>
      <span class="tp-label">${tpLabel}</span>
      <button class="btn-tp" onclick="doTranspose(+1)">+1</button>
      <button class="btn-tp" onclick="doTranspose(+2)">+2</button>
      <button class="btn-tp reset" onclick="state.semitones=0;renderMain()">Reset</button>
      ${state.semitones !== 0 ? `<button class="btn-tp save-tp" onclick="doSalvarTom()">&#128190; Salvar Tom</button>` : ''}
    </div>

    <div class="capo-bar">
      <span class="capo-label">Capo</span>
      <select class="capo-select" id="capo-select">
        <option value="0" ${!song.capo ? 'selected' : ''}>Sem capotraste</option>
        ${[1,2,3,4,5,6,7,8,9,10,11].map(n => `<option value="${n}" ${song.capo == n ? 'selected' : ''}>Casa ${n}</option>`).join('')}
      </select>
      <button class="btn-capo-save" onclick="doSalvarCapo('${jsEsc(song.id)}')">&#128190; Salvar</button>
    </div>

    <div class="font-bar">
      <button class="btn-tp present" onclick="doEnterPresent()" title="Modo apresentação">&#128250; Apresentar</button>
      <button class="btn-format" onclick="doToggleFormat()" title="Alternar formato">${ChordFormat.get() === 'above' ? '&#8942; Sobre' : '&#8801; Acima'}</button>
      <button class="btn-font" onclick="changeFont(-1)">A&#8722;</button>
      <button class="btn-font" onclick="changeFont(+1)">A+</button>
    </div>

    <div class="scroll-bar">
      <button class="btn-scroll" id="btn-scroll" onclick="doToggleScroll()">${AutoScroll.active ? '&#9724; Parar' : '&#9654; Auto-scroll'}</button>
      <button class="btn-scroll-adj" onclick="doAdjScroll(-5)" title="Mais lento">&#8722;</button>
      <span class="scroll-speed" id="scroll-speed">${AutoScroll.speed}</span>
      <button class="btn-scroll-adj" onclick="doAdjScroll(+5)" title="Mais rápido">&#43;</button>
    </div>

    <div class="song-content" id="sc">${content}</div>
    ${state.presenting ? `
      <button class="present-exit" onclick="doExitPresent()" title="Sair (Esc)">&#10005;</button>
      <div class="present-fontbar">
        <button class="btn-scroll-float" onclick="doToggleScroll()" id="btn-scroll-float">${AutoScroll.active ? '&#9724;' : '&#9654;'}</button>
        <button class="btn-font" onclick="changeFont(-1)">A&#8722;</button>
        <button class="btn-font" onclick="changeFont(+1)">A+</button>
      </div>` : ''}`;
}

function viewSetlist() {
  const all = Setlist.all();
  const active = Setlist.active();
  const songs = Setlist.get();

  const tabs = all.length
    ? `<div class="setlist-tabs">
         ${all.map(sl => `
           <button class="setlist-tab ${sl.id === active?.id ? 'active' : ''}" onclick="doSwitchSetlist('${jsEsc(sl.id)}')">
             ${h(sl.name)}
             <span class="setlist-tab-count">${sl.songIds.length}</span>
           </button>`).join('')}
         <button class="setlist-tab-add" onclick="doCreateSetlist()" title="Novo setlist">&#43;</button>
       </div>`
    : '';

  const manageBar = active ? `
    <div class="setlist-manage">
      <span class="setlist-name">${h(active.name)}</span>
      <button class="btn-slman" onclick="doRenameSetlist('${jsEsc(active.id)}')" title="Renomear">&#9998;</button>
      <button class="btn-slman" onclick="doDeleteSetlist('${jsEsc(active.id)}')" title="Excluir setlist">&#128465;</button>
      ${songs.length ? `<button class="btn-slman" onclick="doClearSetlist()" title="Limpar músicas">&#10005;</button>` : ''}
    </div>` : '';

  const list = !all.length
    ? '<div class="empty-state">Nenhum setlist ainda<br><small>Toque no + acima para criar</small></div>'
    : !songs.length
    ? '<div class="empty-state">Setlist vazio<br><small>Adicione músicas pelo repertório usando &#9734;</small></div>'
    : songs.map((s, i) => `
        <div class="setlist-item">
          <span class="setlist-num">${i + 1}</span>
          <div class="setlist-info" onclick="go('song',{songId:'${jsEsc(s.id)}',semitones:0})">
            <span class="song-name">${h(s.title)}</span>
            ${s.key ? `<span class="badge badge-key">${h(s.key)}</span>` : ''}
          </div>
          <div class="setlist-controls">
            ${i > 0
              ? `<button class="btn-move" onclick="Setlist.move(${i},${i-1});renderMain()">&#8593;</button>`
              : '<span class="btn-move-ph"></span>'}
            ${i < songs.length - 1
              ? `<button class="btn-move" onclick="Setlist.move(${i},${i+1});renderMain()">&#8595;</button>`
              : '<span class="btn-move-ph"></span>'}
            <button class="btn-remove" onclick="Setlist.remove('${jsEsc(s.id)}');renderMain()">&#10005;</button>
          </div>
        </div>`).join('');

  return `
    <div class="header">
      <h1>Setlists</h1>
      ${syncBadgeHTML()}
      ${!all.length ? `<button class="btn-icon" onclick="doCreateSetlist()" title="Novo">&#43;</button>` : ''}
    </div>
    ${tabs}
    ${manageBar}
    <div class="setlist-list">${list}</div>`;
}

function viewEdit() {
  const song = state.editSong || {};
  const isNew = !song.id;

  return `
    <div class="header">
      <button class="btn-back" onclick="goBack()">&#8592; Voltar</button>
      <h1>${isNew ? 'Nova Música' : 'Editar Música'}</h1>
    </div>

    <form class="edit-form" onsubmit="doSave(event)">
      <label class="form-label">Título *
        <input class="form-input" type="text" name="title" value="${h(song.title)}" required placeholder="Nome da música">
      </label>

      <label class="form-label">Artista / Compositor
        <input class="form-input" type="text" name="artist" value="${h(song.artist)}" placeholder="Opcional">
      </label>

      <label class="form-label">Tom Original
        <select class="form-select" name="key">
          <option value="">-- Selecionar --</option>
          ${KEYS.map(k => `<option value="${k}" ${song.key === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </label>

      <label class="form-label">Categoria (momento da missa)
        <select class="form-select" name="category">
          <option value="">-- Selecionar --</option>
          ${CATS.map(c => `<option value="${h(c)}" ${song.category === c ? 'selected' : ''}>${h(c)}</option>`).join('')}
        </select>
      </label>

      <label class="form-label">
        Anotações
        <span class="form-hint">BPM, arranjo, quem canta o solo, links de referência, etc.</span>
        <textarea class="form-textarea form-notes" name="notes" placeholder="Ex: 72 bpm, solo de flauta no refrão, entrada com voz feminina...">${h(song.notes)}</textarea>
      </label>

      <label class="form-label">
        Letra com Cifras
        <span class="form-hint">
          &#128161; Cole direto do <strong>Cifra Club</strong> e clique em "Converter" &#8594; o app ajusta automaticamente.<br>
          Ou escreva no formato: <code>[C]palavra [G]outra</code>
        </span>
        <textarea class="form-textarea" id="ta-content" name="content" placeholder="Cole aqui a letra copiada do Cifra Club e clique em Converter&#10;&#10;Ou escreva direto:&#10;[C]Senhor, [G]eu preciso de ti&#10;[Am]Venho a tua [F]presença">${h(song.content)}</textarea>
      </label>
      <button type="button" class="btn-convert" onclick="doConvert()">&#8635; Converter formato Cifra Club</button>

      <div class="form-actions">
        ${!isNew ? `<button type="button" class="btn-danger" onclick="doDelete('${jsEsc(song.id)}')">Excluir</button>` : '<span></span>'}
        <button type="submit" class="btn-primary">Salvar</button>
      </div>
    </form>`;
}

function viewBusca() {
  return `
    <div class="header">
      <h1>&#127758; Buscar Online</h1>
      ${syncBadgeHTML()}
    </div>

    <div class="busca-form">
      <input class="search-input" type="search" id="q-online" placeholder="Nome da música ou artista..."
        onkeydown="if(event.key==='Enter'){this.blur();doBuscar()}">
      <button class="btn-buscar" onclick="doBuscar()">Buscar</button>
    </div>

    <div class="busca-url-row">
      <input class="search-input" type="url" id="q-url" placeholder="Ou cole a URL do Cifra Club aqui...">
      <button class="btn-buscar btn-url" onclick="doImportarUrl()">Importar</button>
    </div>

    <div id="busca-results">
      <div class="busca-status">
        <strong>Como usar:</strong><br>
        &#8226; Busque pelo nome da música, ou<br>
        &#8226; Abra o Cifra Club no Safari, copie o endereço (URL) da música e cole no campo acima.<br><br>
        <small>Requer conexão com a internet.</small>
      </div>
    </div>`;
}

function viewSettings() {
  const count = Songs.all().length;
  const cloudUrl = Cloud.url;
  const cloudOk = Cloud.isConfigured();
  const pending = Cloud.pendingCount();
  const cloudState = Cloud.state;

  const statusMsg = !cloudOk
    ? '&#9898; Não configurado. Configure para compartilhar o repertório entre dispositivos.'
    : cloudState === 'syncing' ? '&#8635; Sincronizando...'
    : cloudState === 'error'   ? `&#9888;&#65039; Erro na sincronização. ${pending} alteraç${pending !== 1 ? 'ões' : 'ão'} pendente${pending !== 1 ? 's' : ''}.`
    : cloudState === 'pending' ? `&#8987; ${pending} alteraç${pending !== 1 ? 'ões' : 'ão'} aguardando envio.`
    : '&#9989; Nuvem configurada e sincronizada.';

  return `
    <div class="header">
      <button class="btn-back" onclick="goBack()">&#8592; Voltar</button>
      <h1>Configurações</h1>
    </div>

    <div class="settings-section">
      <h3>&#9729; Sincronização em Nuvem</h3>
      <p style="margin-bottom:0.75rem">${statusMsg}</p>
      <input class="form-input" type="url" id="cloud-url" style="margin-bottom:0.5rem"
        placeholder="Cole aqui a URL do Apps Script..."
        value="${h(cloudUrl)}">
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn-primary" style="flex:1" onclick="doSaveCloudUrl()">Salvar URL</button>
        ${cloudOk ? `<button class="btn-setting" style="flex:1;margin:0" onclick="doSyncNow()">&#8635; Sincronizar agora</button>` : ''}
      </div>
      <p style="margin-top:0.75rem;font-size:0.8rem;color:var(--muted)">
        Veja o arquivo <strong>Code.gs</strong> na pasta do projeto para instruções de configuração.
      </p>
    </div>

    <div class="settings-section">
      <h3>&#9789; Aparência</h3>
      <div class="theme-picker">
        ${['auto','light','dark'].map(m => `
          <button class="theme-btn ${Theme.get() === m ? 'active' : ''}" onclick="doSetTheme('${m}')">
            ${m === 'auto' ? '&#128241; Auto' : m === 'light' ? '&#9728;&#65039; Claro' : '&#127769; Escuro'}
          </button>
        `).join('')}
      </div>
      <p style="margin-top:0.5rem;font-size:0.8rem">Auto segue a preferência do sistema.</p>
    </div>

    <div class="settings-section">
      <h3>Repertório</h3>
      <p>${count} música${count !== 1 ? 's' : ''} cadastrada${count !== 1 ? 's' : ''}</p>
    </div>

    <div class="settings-section">
      <h3>Backup Local</h3>
      <button class="btn-setting" onclick="doExport()">&#128229; Exportar backup (.json)</button>
      <button class="btn-setting" onclick="document.getElementById('imp').click()">&#128228; Importar backup (.json)</button>
      <input type="file" id="imp" accept=".json" style="display:none" onchange="doImport(event)">
    </div>

    <div class="settings-section">
      <h3>Instalar no iPhone / iPad</h3>
      <p>No Safari: toque em <strong>Compartilhar &#9633;&#8593;</strong> → <strong>Adicionar à Tela de Início</strong>.</p>
    </div>

    <div class="settings-section">
      <h3>Sobre</h3>
      <p>Cifras da Igreja v1.0 — App gratuito para grupos de louvor.</p>
    </div>`;
}

// ── ACTIONS ───────────────────────────────────

function doEditCurrentSong() {
  const song = Songs.get(state.songId);
  if (!song) return;
  go('edit', { editSong: song, songId: song.id });
}

function doSetTheme(mode) {
  Theme.set(mode);
  renderMain();
}

async function doEnterPresent() {
  state.presenting = true;
  document.body.classList.add('is-presenting');
  renderMain();
  if ('wakeLock' in navigator) {
    try { _wakeLock = await navigator.wakeLock.request('screen'); }
    catch {}
  }
}

function doExitPresent() {
  state.presenting = false;
  document.body.classList.remove('is-presenting');
  if (_wakeLock) { try { _wakeLock.release(); } catch {} _wakeLock = null; }
  renderMain();
}

function doToggleScroll() {
  AutoScroll.toggle();
  // Atualiza botões inline sem repintar a página inteira (evita perder posição)
  const b1 = document.getElementById('btn-scroll');
  const b2 = document.getElementById('btn-scroll-float');
  if (b1) b1.innerHTML = AutoScroll.active ? '&#9724; Parar' : '&#9654; Auto-scroll';
  if (b2) b2.innerHTML = AutoScroll.active ? '&#9724;' : '&#9654;';
}

function doAdjScroll(delta) {
  AutoScroll.setSpeed(AutoScroll.speed + delta);
  const s = document.getElementById('scroll-speed');
  if (s) s.textContent = AutoScroll.speed;
}

function doToggleFormat() {
  ChordFormat.toggle();
  renderMain();
}

// Indicador global de sync (aparece no header de todas as telas se configurado)
function syncBadgeHTML() {
  if (!Cloud.isConfigured()) return '';
  const s = Cloud.state;
  const pending = Cloud.pendingCount();
  const map = {
    syncing: { cls: 'sync-syncing', title: 'Sincronizando...', text: '&#8635;' },
    pending: { cls: 'sync-pending', title: `${pending} alteração(ões) aguardando envio`, text: String(pending) },
    error:   { cls: 'sync-error',   title: 'Erro na sincronização — toque para ver',    text: '!' },
    idle:    { cls: 'sync-ok',      title: 'Sincronizado',                              text: '&#10003;' }
  };
  const info = map[s] || map.idle;
  return `<button class="sync-badge ${info.cls}" onclick="go('settings')" title="${info.title}">${info.text}</button>`;
}

// Se sair da tela da música por qualquer motivo, encerra apresentação
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.presenting && !_wakeLock && 'wakeLock' in navigator) {
    try { _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.presenting) doExitPresent();
});

function doTranspose(delta) {
  state.semitones += delta;
  renderMain();
}

function doSalvarTom() {
  const song = Songs.get(state.songId);
  if (!song || state.semitones === 0) return;

  const useFlats = detectFlats(song.content);
  const newContent = transposeContent(song.content, state.semitones, useFlats);
  const newKey = song.key ? displayKey(song.key, state.semitones) : '';

  Songs.save({ ...song, content: newContent, key: newKey });
  state.semitones = 0;
  renderMain();
}

function doSalvarCapo(id) {
  const song = Songs.get(id);
  if (!song) return;
  const capo = parseInt(document.getElementById('capo-select')?.value) || 0;
  Songs.save({ ...song, capo });
  renderMain();
}

function changeFont(delta) {
  const el = document.getElementById('sc');
  if (!el) return;
  const cur = parseFloat(getComputedStyle(el).fontSize);
  el.style.fontSize = Math.max(10, Math.min(30, cur + delta * 2)) + 'px';
}

function toggleSetlist(id) {
  if (Setlist.has(id)) Setlist.remove(id);
  else Setlist.add(id);
  renderMain();
}

function doClearSetlist() {
  if (confirm('Limpar as músicas deste setlist?')) { Setlist.clear(); renderMain(); }
}

function doSwitchSetlist(id) {
  Setlist.setActive(id);
  renderMain();
}

function doCreateSetlist() {
  const name = prompt('Nome do novo setlist (ex: Missa Domingo, Ensaio):');
  if (name === null) return;
  Setlist.create(name);
  renderMain();
}

function doRenameSetlist(id) {
  const cur = Setlist.all().find(s => s.id === id);
  if (!cur) return;
  const name = prompt('Novo nome:', cur.name);
  if (name === null) return;
  Setlist.rename(id, name);
  renderMain();
}

function doDeleteSetlist(id) {
  const cur = Setlist.all().find(s => s.id === id);
  if (!cur) return;
  if (!confirm(`Excluir o setlist "${cur.name}"? As músicas continuam no repertório.`)) return;
  Setlist.delete(id);
  renderMain();
}

function doSave(e) {
  e.preventDefault();
  const f = e.target;
  const song = {
    ...(state.editSong || {}),
    title: f.title.value.trim(),
    artist: f.artist.value.trim(),
    key: f.key.value,
    capo: state.editSong?.capo || 0,
    category: f.category.value,
    notes: f.notes.value.trim(),
    content: f.content.value,
  };
  const id = Songs.save(song);
  go('song', { songId: id, semitones: 0, editSong: null });
}

function doDelete(id) {
  if (confirm('Excluir esta música permanentemente?')) {
    Songs.delete(id);
    go('repertorio', { songId: null, editSong: null });
  }
}

async function doImportarUrl() {
  const url = (document.getElementById('q-url')?.value || '').trim();
  if (!url) { alert('Cole a URL do Cifra Club primeiro.'); return; }
  if (!url.includes('cifraclub')) { alert('Use uma URL do cifraclub.com.br'); return; }

  const loading = document.createElement('div');
  loading.className = 'import-loading';
  loading.innerHTML = '<div class="import-loading-box">&#9835; Importando...<br><small>Aguarde</small></div>';
  document.body.appendChild(loading);

  try {
    const song = await importCifraClub(url);
    document.body.removeChild(loading);
    if (!song.content) { alert('Não encontrei cifras nessa página. Tente outra música.'); return; }
    go('edit', { editSong: { title: song.title, artist: song.artist, key: '', category: '', content: song.content }, songId: null });
  } catch(e) {
    document.body.removeChild(loading);
    alert('Erro ao importar: ' + e.message);
  }
}

function doSaveCloudUrl() {
  const url = (document.getElementById('cloud-url')?.value || '').trim();
  if (url && !url.startsWith('https://script.google.com')) {
    alert('URL inválida. Deve começar com https://script.google.com');
    return;
  }
  Cloud.setUrl(url);
  alert(url ? 'URL salva! Sincronizando...' : 'Nuvem desativada.');
  if (url) doSyncNow();
  else renderMain();
}

async function doSyncNow() {
  const btn = document.querySelector('[onclick="doSyncNow()"]');
  if (btn) btn.textContent = '⏳ Sincronizando...';

  const result = await Cloud.pull();
  renderMain();
  if (result.ok) {
    const pending = Cloud.pendingCount();
    if (pending > 0) alert(`Sincronizado, mas ${pending} alteração(ões) ainda pendente(s).`);
    else alert(`✅ Sincronizado! ${result.count} músicas na nuvem.`);
  } else {
    alert('Erro ao sincronizar: ' + (result.reason || 'verifique a URL'));
  }
}

async function doBuscar() {
  const q = (document.getElementById('q-online')?.value || '').trim();
  if (!q) return;
  const el = document.getElementById('busca-results');
  if (!el) return;
  el.innerHTML = '<div class="busca-status">Buscando...</div>';

  try {
    const results = await searchCifraClub(q);
    if (!results.length) {
      el.innerHTML = '<div class="busca-status">Nenhum resultado encontrado.<br>Tente outros termos.</div>';
      return;
    }
    el.innerHTML = results.map((r, i) => `
      <div class="result-item" onclick="doImportar(${i})">
        <div class="result-item-body">
          <span class="song-name">${h(r.title)}</span>
          <span class="song-sub">${h(r.artist)}</span>
        </div>
        <span class="result-arrow">&#8594;</span>
      </div>`).join('');
    // Guarda resultados para importar pelo índice
    window._buscaResults = results;
  } catch {
    el.innerHTML = '<div class="busca-status">Erro ao buscar.<br>Verifique sua conexão com a internet.</div>';
  }
}

async function doImportar(idx) {
  const result = (window._buscaResults || [])[idx];
  if (!result) return;

  const loading = document.createElement('div');
  loading.className = 'import-loading';
  loading.innerHTML = '<div class="import-loading-box">&#9835; Importando música...<br><small>Aguarde</small></div>';
  document.body.appendChild(loading);

  try {
    const song = await importCifraClub(result.url);
    document.body.removeChild(loading);
    go('edit', {
      editSong: {
        title: song.title || result.title,
        artist: song.artist || result.artist,
        key: '',
        category: '',
        content: song.content
      },
      songId: null
    });
  } catch {
    document.body.removeChild(loading);
    alert('Não foi possível importar esta música.\nTente outra ou adicione manualmente.');
  }
}

function doConvert() {
  const ta = document.getElementById('ta-content');
  if (!ta) return;
  const converted = convertCifraClub(ta.value);
  ta.value = converted;
  ta.focus();
}

function doExport() {
  const blob = new Blob([Storage.export()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cifras-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    if (Storage.import(ev.target.result)) {
      alert('Backup importado com sucesso!');
      go('repertorio');
    } else {
      alert('Erro ao importar. Verifique se o arquivo é um backup válido.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── RENDER ────────────────────────────────────

function renderMain() {
  const views = { repertorio: viewRepertorio, song: viewSong, setlist: viewSetlist, edit: viewEdit, settings: viewSettings, busca: viewBusca };
  document.getElementById('main').innerHTML = (views[state.view] || viewRepertorio)();
  updateNav();
}

function updateNav() {
  const nav = document.getElementById('bottom-nav');
  const hide = ['song', 'edit', 'settings'].includes(state.view);
  nav.style.display = hide ? 'none' : 'flex';
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
}

function render() { renderMain(); }

// ── INIT ──────────────────────────────────────

window.addEventListener('popstate', e => {
  if (e.state && e.state.view) {
    Object.assign(state, e.state);
    renderMain();
    window.scrollTo(0, 0);
  } else {
    Object.assign(state, { view: 'repertorio' });
    renderMain();
  }
});

async function init() {
  Theme.apply();
  // Se estiver em modo auto, atualiza quando o sistema mudar
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (Theme.get() === 'auto') Theme.apply();
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // Recarrega automaticamente quando um novo SW assumir controle
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  }

  // Sincroniza com nuvem se configurado (sem bloquear a UI)
  if (Cloud.isConfigured() && navigator.onLine) {
    Cloud.pull().then(r => { if (r.ok) renderMain(); }).catch(() => {});
  }

  // Atualiza header e tela de configurações em tempo real quando o status da nuvem muda
  window.addEventListener('cloud:status', () => {
    // Atualiza só o badge nas telas onde não faz diferença repintar
    document.querySelectorAll('.sync-badge').forEach(el => el.outerHTML = syncBadgeHTML());
    if (state.view === 'settings') renderMain();
  });

  if (Songs.all().length === 0) loadSampleSongs();
  history.replaceState({ ...state }, '');
  renderMain();
}

window.addEventListener('DOMContentLoaded', init);
