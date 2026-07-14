/* =========================================================================
 * GOOGLE APPS SCRIPT — бэкенд опроса (привязать к таблице AiEmployeeTest).
 * Extensions ▸ Apps Script ▸ вставить код ▸ Deploy ▸ Web app
 *   (Execute as: Me, Who has access: Anyone) ▸ URL /exec -> js/config.js API_URL.
 *
 * Листы:
 *   Employees : ID | ФИО | Отдел | Должность | Токен | Использование |
 *               Дата и время прохождения | Процент правильных ответов |
 *               Балл самооценки | Средний балл на основе ответов |
 *               Принятие/готовность использовать ИИ | Интерес и инициативность |
 *               Безопасность и ответственность | Портрет
 *   Questions : ID(1)|Отношение(1) | ID(2)|Интерес(2) | ID(3)|Навыки(3)  (пары колонок)
 *   Answers   : ID вопроса | Вариант A | B | C | D | Номер правильного ответа |
 *               Тег A | Тег B | Тег C | Тег D
 *   Results   : ID пользователя | ID вопроса | Ответ | Дата и время получения  (лог)
 * ========================================================================= */

function doGet(e) {
  var p = e.parameter || {};
  var out;
  try {
    switch (p.action) {
      case 'validateCode': out = validateCode(p.code); break;
      case 'getSurvey':    out = getSurvey(p); break;
      case 'getQuestions': out = getQuestionsForEmployee(p); break;
      case 'saveAnswer':   out = saveAnswer(p); break;
      case 'saveAnswers':  out = saveAnswers(p); break;
      case 'finish':       out = finish(p); break;
      default:             out = { error: 'unknown_action' };
    }
  } catch (err) { out = { error: String(err) }; }
  return respond(out, p.callback);
}

function respond(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function sheet(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Лист "' + name + '" не найден');
  return sh;
}
function header(sh) { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }
function colIndex(head, name) { return head.indexOf(name); }

function hasEmployeeCredentials(employeeId, code) {
  var sh = sheet('Employees');
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iId = colIndex(h, 'ID'), iTok = colIndex(h, 'Токен');
  if (iId < 0 || iTok < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) === String(employeeId) &&
        String(data[r][iTok]).trim() === String(code || '').trim()) return true;
  }
  return false;
}

/* Вопросы выдаются только активному сотруднику с совпавшей парой ID + токен. */
function hasActiveEmployeeCredentials(employeeId, code) {
  if (employeeId === '' || employeeId == null || !code) return false;
  var sh = sheet('Employees');
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iId = colIndex(h, 'ID'), iTok = colIndex(h, 'Токен'), iUse = colIndex(h, 'Использование');
  if (iId < 0 || iTok < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== String(employeeId) ||
        String(data[r][iTok]).trim() !== String(code).trim()) continue;
    var usage = iUse >= 0 ? String(data[r][iUse]).trim().toLowerCase() : '';
    return usage !== 'использован';
  }
  return false;
}

/* --- Проверка кода: завершённый токен блокируется, остальные можно продолжить. --- */
function validateCode(code) {
  if (!code) return { valid: false, reason: 'empty' };
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = sheet('Employees');
    var data = sh.getDataRange().getValues();
    var h = data[0];
    var iId = colIndex(h, 'ID'), iFio = colIndex(h, 'ФИО'),
        iTok = colIndex(h, 'Токен'), iUse = colIndex(h, 'Использование');
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iTok]).trim() === String(code).trim()) {
        var usage = iUse >= 0 ? String(data[r][iUse]).trim() : '';
        if (usage.toLowerCase() === 'использован') return { valid: false, reason: 'used' };
        return { valid: true, id: data[r][iId], fio: data[r][iFio], usage: usage };
      }
    }
    return { valid: false, reason: 'not_found' };
  } finally { lock.releaseLock(); }
}

/* --- Весь опрос из таблицы: только после повторной проверки ID + токена. --- */
function getSurvey(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  return { ok: true, questions: getQuestions(), principles: getPrinciples(), prompt: getSetting('prompt') };
}

/* Старый отдельный action тоже не должен раскрывать вопросы без авторизации. */
function getQuestionsForEmployee(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  return { ok: true, questions: getQuestions() };
}

/* Принципы — лист Principles, первый столбец (по одному в строке). */
function getPrinciples() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Principles');
  if (!sh) return [];
  return sh.getRange(1, 1, sh.getLastRow(), 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (s) { return s; });
}

/* Настройки — лист Settings (A=ключ, B=значение). Промпт хранится тут (ключ "prompt"). */
function getSetting(key) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Settings');
  if (sh) {
    var data = sh.getDataRange().getValues();
    for (var r = 0; r < data.length; r++) {
      if (String(data[r][0]).trim() === key) return String(data[r][1]);
    }
  }
  return '';
}

/* --- Вопросы: Questions (текст) + Answers (варианты/правильный/теги). --- */
function getQuestions() {
  // карта id -> текст из листа Questions (пары колонок 0-1, 2-3, 4-5)
  var qd = sheet('Questions').getDataRange().getValues();
  var text = {};
  for (var r = 1; r < qd.length; r++) {
    [[0, 1], [2, 3], [4, 5]].forEach(function (p) {
      var id = qd[r][p[0]], t = qd[r][p[1]];
      if (id !== '' && id != null && t) text[String(parseInt(id, 10))] = String(t).trim();
    });
  }

  var ad = sheet('Answers').getDataRange().getValues();
  var h = ad[0];
  var byId = {};
  for (var i = 1; i < ad.length; i++) {
    var id = ad[i][0]; if (id === '' || id == null) continue;
    byId[String(parseInt(id, 10))] = ad[i];
  }
  var iA = 1, iB = 2, iC = 3, iD = 4, iCorr = 5;
  var iTA = colIndex(h, 'Тег A'), iTB = colIndex(h, 'Тег B'),
      iTC = colIndex(h, 'Тег C'), iTD = colIndex(h, 'Тег D');

  var order = ['511'];
  for (var n = 101; n <= 110; n++) order.push(String(n));
  for (n = 201; n <= 210; n++) order.push(String(n));
  for (n = 301; n <= 310; n++) order.push(String(n));
  order.push('411');

  var mascot = { attitude: 'neutral', interest: 'happy', knowledge: 'thinking', security: 'thinking', self: 'neutral' };
  function blockOf(id) {
    return { '1': 'attitude', '2': 'interest', '3': 'knowledge', '4': 'security', '5': 'self' }[id.charAt(0)];
  }
  function isOwn(s) { return String(s || '').indexOf('вой вариант') >= 0; }

  var out = [];
  order.forEach(function (id) {
    var row = byId[id]; if (!row) return;
    var blk = blockOf(id);
    var q = { id: id, block: blk, mascot: mascot[blk], text: text[id] || '' };
    var opts = [
      { key: 'A', text: row[iA], tag: iTA >= 0 ? row[iTA] : '' },
      { key: 'B', text: row[iB], tag: iTB >= 0 ? row[iTB] : '' },
      { key: 'C', text: row[iC], tag: iTC >= 0 ? row[iTC] : '' },
      { key: 'D', text: row[iD], tag: iTD >= 0 ? row[iTD] : '' },
    ];
    if (blk === 'knowledge') {
      q.type = 'knowledge';
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null; })
                      .map(function (o) { return { key: o.key, text: String(o.text) }; });
      q.correct = String(row[iCorr]).trim();
    } else if (blk === 'self') {
      q.type = 'self';
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null; })
                      .map(function (o) { return { key: o.key, text: String(o.text), tag: String(o.tag || '') }; });
    } else {
      q.type = 'profile';
      q.allowOwn = opts.some(function (o) { return isOwn(o.text); });
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null && !isOwn(o.text); })
                      .map(function (o) { return { key: o.key, text: String(o.text), tag: String(o.tag || '') }; });
    }
    out.push(q);
  });
  return out;
}

/* --- Один ответ -> лог в Results; первый ответ переводит токен в «Частично». --- */
function saveAnswer(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, reason: 'invalid_credentials' };
    var sh = sheet('Results');
    sh.appendRow([p.id, p.questionId, p.answer == null ? '' : p.answer, new Date()]);
    setUsage(p.id, 'Частично', false);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* --- Финальная идемпотентная синхронизация локального состояния. --- */
/* Досылает отсутствующие ответы одним запросом и обновляет изменённые, поэтому
 * повтор после сетевого таймаута не создаёт новые строки для тех же вопросов. */
function saveAnswers(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, reason: 'invalid_credentials' };

    var incoming;
    try { incoming = JSON.parse(p.answers || '[]'); }
    catch (err) { return { ok: false, reason: 'invalid_answers' }; }
    if (!Array.isArray(incoming)) return { ok: false, reason: 'invalid_answers' };

    var allowed = {};
    getQuestions().forEach(function (q) { allowed[String(q.id)] = true; });
    var latest = {};
    incoming.forEach(function (item) {
      if (!item || item.questionId == null) return;
      var questionId = String(parseInt(item.questionId, 10));
      if (!allowed[questionId]) return;
      latest[questionId] = item.answer == null ? '' : item.answer;
    });

    var sh = sheet('Results');
    var data = sh.getDataRange().getValues();
    var existing = {};
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][0]) !== String(p.id)) continue;
      var existingId = String(parseInt(data[r][1], 10));
      if (allowed[existingId]) existing[existingId] = r + 1;
    }

    var now = new Date();
    var append = [];
    var updated = 0;
    Object.keys(latest).forEach(function (questionId) {
      var row = existing[questionId];
      if (!row) {
        append.push([p.id, questionId, latest[questionId], now]);
        return;
      }
      var current = data[row - 1][2] == null ? '' : data[row - 1][2];
      if (String(current) !== String(latest[questionId])) {
        sh.getRange(row, 3, 1, 2).setValues([[latest[questionId], now]]);
        updated += 1;
      }
    });
    if (append.length) {
      sh.getRange(sh.getLastRow() + 1, 1, append.length, 4).setValues(append);
    }
    if (Object.keys(latest).length) setUsage(p.id, 'Частично', false);
    return { ok: true, saved: Object.keys(latest).length, appended: append.length, updated: updated };
  } finally { lock.releaseLock(); }
}

function setUsage(employeeId, value, overwriteUsed) {
  var sh = sheet('Employees');
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iId = colIndex(h, 'ID'), iUse = colIndex(h, 'Использование');
  if (iId < 0 || iUse < 0) return false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iId]) !== String(employeeId)) continue;
    var current = String(data[r][iUse]).trim().toLowerCase();
    if (overwriteUsed || current !== 'использован') sh.getRange(r + 1, iUse + 1).setValue(value);
    return true;
  }
  return false;
}

function answeredQuestionCount(employeeId, expectedIds) {
  var data = sheet('Results').getDataRange().getValues();
  var expected = {};
  expectedIds.forEach(function (id) { expected[String(id)] = true; });
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(employeeId) && data[r][1] !== '' && data[r][1] != null) {
      var questionId = String(parseInt(data[r][1], 10));
      if (expected[questionId]) seen[questionId] = true;
    }
  }
  return Object.keys(seen).length;
}

/* --- Завершение -> «Использован» и сводка только после всех ответов. --- */
function finish(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if (!hasEmployeeCredentials(p.id, p.code)) return { ok: false, reason: 'invalid_credentials' };
    var res = JSON.parse(p.results || '{}');
    var questions = getQuestions();
    var questionIds = questions.map(function (q) { return q.id; });
    var answered = answeredQuestionCount(p.id, questionIds);
    var total = questionIds.length;
    if (answered < total) {
      setUsage(p.id, 'Частично', false);
      return { ok: false, reason: 'incomplete', answered: answered, total: total };
    }
    var sh = sheet('Employees');
    var data = sh.getDataRange().getValues();
    var h = data[0];
    var iId = colIndex(h, 'ID');
    var map = {
      'Использование': 'Использован',
      'Дата и время прохождения': new Date(),
      'Процент правильных ответов': res.percentCorrect,
      'Балл самооценки': res.selfScore,
      'Средний балл на основе ответов': res.portraitScore,
      'Принятие/готовность использовать ИИ': res.adoptionScore,
      'Интерес и инициативность': res.interestScore,
      'Безопасность и ответственность': res.safetyScore,
      'Портрет': res.portraitLabel,
    };
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === String(p.id)) {
        Object.keys(map).forEach(function (col) {
          var c = colIndex(h, col);
          if (c >= 0 && map[col] !== undefined && map[col] !== null) sh.getRange(r + 1, c + 1).setValue(map[col]);
        });
        return { ok: true };
      }
    }
    return { ok: false, reason: 'employee_not_found' };
  } finally { lock.releaseLock(); }
}
