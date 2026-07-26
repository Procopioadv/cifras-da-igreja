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

const HEADERS = ['id','title','artist','key','capo','category','content','createdAt','updatedAt'];

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName('Músicas');
  if (!s) {
    s = ss.insertSheet('Músicas');
    s.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    s.setFrozenRows(1);
    s.setColumnWidth(6, 600); // coluna content mais larga
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
        updatedAt: Number(r[8] || 0)
      }));
    const props = PropertiesService.getScriptProperties();
    const setlist = JSON.parse(props.getProperty('setlist') || '[]');
    const setlistUpdatedAt = Number(props.getProperty('setlistUpdatedAt') || 0);
    return out({ ok: true, songs, setlist, setlistUpdatedAt });
  } catch(e) {
    return out({ ok: false, error: e.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'save')    return out(saveSong(body.song));
    if (body.action === 'delete')  return out(deleteSong(body.id));
    if (body.action === 'setlist') return out(saveSetlist(body));
    return out({ ok: false, error: 'ação inválida' });
  } catch(e) {
    return out({ ok: false, error: e.message });
  }
}

function saveSetlist(body) {
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : [];
  const updatedAt = Number(body.updatedAt) || Date.now();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('setlist', JSON.stringify(ids));
  props.setProperty('setlistUpdatedAt', String(updatedAt));
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
        song.capo||0, song.category||'', song.content||'', rows[i][7], now
      ]]);
      return { ok: true, id: song.id };
    }
  }

  const id = song.id || Utilities.getUuid();
  sheet.appendRow([
    id, song.title||'', song.artist||'', song.key||'',
    song.capo||0, song.category||'', song.content||'', song.createdAt||now, now
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
