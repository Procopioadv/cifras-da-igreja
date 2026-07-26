// ============================================================
// Cifras da Igreja — Backend Google Apps Script
// ============================================================
// COMO INSTALAR:
// 1. Crie uma planilha no Google Sheets (sheets.google.com)
// 2. Clique em Extensões > Apps Script
// 3. Apague o código existente e cole TODO este arquivo
// 4. Clique em Implantar > Nova implantação
//    - Tipo: App da Web
//    - Executar como: Eu mesmo
//    - Quem tem acesso: Qualquer pessoa
// 5. Autorize e copie a URL gerada
// 6. Cole a URL em Configurações > Sincronização em Nuvem no app
// ============================================================

const HEADERS = ['id','title','artist','key','capo','category','content','createdAt','updatedAt','notes'];

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName('Músicas');
  if (!s) {
    s = ss.insertSheet('Músicas');
    s.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    s.setFrozenRows(1);
    s.setColumnWidth(6, 600); // coluna content mais larga
  } else {
    // Se o schema evoluiu, adiciona colunas novas ao cabeçalho
    const lastCol = s.getLastColumn();
    if (lastCol < HEADERS.length) {
      s.getRange(1, lastCol + 1, 1, HEADERS.length - lastCol)
        .setValues([HEADERS.slice(lastCol)]);
    }
  }
  return s;
}

function out(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  try {
    const sheet = getSheet();
    const rows = sheet.getDataRange().getValues();
    const songs = rows.slice(1)
      .filter(r => r[0])
      .map(r => ({
        id:        String(r[0]),
        title:     String(r[1] || ''),
        artist:    String(r[2] || ''),
        key:       String(r[3] || ''),
        capo:      Number(r[4] || 0),
        category:  String(r[5] || ''),
        content:   String(r[6] || ''),
        createdAt: Number(r[7] || 0),
        updatedAt: Number(r[8] || 0),
        notes:     String(r[9] || '')
      }));
    const props = PropertiesService.getScriptProperties();
    let setlists = JSON.parse(props.getProperty('setlists') || 'null');
    let setlistsUpdatedAt = Number(props.getProperty('setlistsUpdatedAt') || 0);
    // Migração automática: se só tiver o setlist antigo, converte
    if (!Array.isArray(setlists)) {
      const oldList = JSON.parse(props.getProperty('setlist') || '[]');
      const oldTs = Number(props.getProperty('setlistUpdatedAt') || 0);
      if (Array.isArray(oldList) && oldList.length > 0) {
        const now = oldTs || Date.now();
        setlists = [{
          id: Utilities.getUuid(),
          name: 'Setlist',
          songIds: oldList,
          updatedAt: now,
          createdAt: now
        }];
        setlistsUpdatedAt = now;
        props.setProperty('setlists', JSON.stringify(setlists));
        props.setProperty('setlistsUpdatedAt', String(setlistsUpdatedAt));
      } else {
        setlists = [];
      }
    }
    return out({ ok: true, songs, setlists, setlistsUpdatedAt });
  } catch(e) {
    return out({ ok: false, error: e.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'save')     return out(saveSong(body.song));
    if (body.action === 'delete')   return out(deleteSong(body.id));
    if (body.action === 'setlists') return out(saveSetlists(body));
    if (body.action === 'backup')   return out(doBackup(body));
    return out({ ok: false, error: 'ação inválida' });
  } catch(e) {
    return out({ ok: false, error: e.message });
  }
}

function getBackupFolder() {
  const name = 'Cifras Backups';
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function doBackup(body) {
  const data = body.data || {};
  if (!Array.isArray(data.songs)) return { ok: false, error: 'dados inválidos' };
  const folder = getBackupFolder();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT-3', 'yyyy-MM-dd_HH-mm');
  const name = `cifras-backup-${stamp}.json`;
  const file = folder.createFile(name, JSON.stringify(data), 'application/json');
  // Mantém no máximo 30 backups (remove os mais antigos)
  const files = [];
  const iter = folder.getFilesByType('application/json');
  while (iter.hasNext()) files.push(iter.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(30).forEach(f => f.setTrashed(true));
  return { ok: true, name, id: file.getId(), url: file.getUrl(), total: Math.min(files.length, 30) };
}

function saveSetlists(body) {
  const setlists = Array.isArray(body.setlists) ? body.setlists.filter(sl =>
    sl && typeof sl.id === 'string' && typeof sl.name === 'string' && Array.isArray(sl.songIds)
  ) : [];
  const updatedAt = Number(body.updatedAt) || Date.now();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('setlists', JSON.stringify(setlists));
  props.setProperty('setlistsUpdatedAt', String(updatedAt));
  return { ok: true, updatedAt };
}

function saveSong(song) {
  const sheet = getSheet();
  const rows  = sheet.getDataRange().getValues();
  const now   = Date.now();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(song.id)) {
      sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([[
        song.id, song.title||'', song.artist||'', song.key||'',
        song.capo||0, song.category||'', song.content||'', rows[i][7], now, song.notes||''
      ]]);
      return { ok: true, id: song.id };
    }
  }

  const id = song.id || Utilities.getUuid();
  sheet.appendRow([
    id, song.title||'', song.artist||'', song.key||'',
    song.capo||0, song.category||'', song.content||'', song.createdAt||now, now, song.notes||''
  ]);
  return { ok: true, id };
}

function deleteSong(id) {
  const sheet = getSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'não encontrado' };
}
