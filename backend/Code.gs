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
 *               Безопасность и ответственность | Портрет | Таймер
 *   Questions : ID вопроса | Вопрос | Включен
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
function normalizeQuestionId(value) {
  if (value === '' || value == null) return '';
  var id = String(value).trim();
  return /^\d+(?:\.0+)?$/.test(id) ? String(parseInt(id, 10)) : id;
}
function checked(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

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
        iTok = colIndex(h, 'Токен'), iUse = colIndex(h, 'Использование'),
        iTimer = colIndex(h, 'Таймер');
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iTok]).trim() === String(code).trim()) {
        var usage = iUse >= 0 ? String(data[r][iUse]).trim() : '';
        if (usage.toLowerCase() === 'использован') return { valid: false, reason: 'used' };
        var timerEnabled = iTimer < 0
          ? true
          : data[r][iTimer] === true || String(data[r][iTimer]).trim().toLowerCase() === 'true';
        return {
          valid: true, id: data[r][iId], fio: data[r][iFio], usage: usage,
          timerEnabled: timerEnabled
        };
      }
    }
    return { valid: false, reason: 'not_found' };
  } finally { lock.releaseLock(); }
}

/* --- Весь опрос из таблицы: только после повторной проверки ID + токена. --- */
function getSurvey(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  var questions = getQuestions();
  if (!questions.length) return { ok: false, error: 'no_active_questions' };
  return { ok: true, questions: questions, principles: getPrinciples(), prompt: getSetting('prompt') };
}

/* Старый отдельный action тоже не должен раскрывать вопросы без авторизации. */
function getQuestionsForEmployee(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  var questions = getQuestions();
  if (!questions.length) return { ok: false, error: 'no_active_questions' };
  return { ok: true, questions: questions };
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
  var qd = sheet('Questions').getDataRange().getValues();
  var qh = qd[0] || [];
  var iQId = colIndex(qh, 'ID вопроса'), iQText = colIndex(qh, 'Вопрос');
  var iEnabled = colIndex(qh, 'Включен');
  if (iEnabled < 0) iEnabled = colIndex(qh, 'Включить');
  if (iEnabled < 0) iEnabled = colIndex(qh, 'Включено');
  if (iQId < 0 || iQText < 0) return [];
  var ordered = [];
  var seenQuestions = {};
  for (var r = 1; r < qd.length; r++) {
    var questionId = normalizeQuestionId(qd[r][iQId]);
    var questionText = String(qd[r][iQText] || '').trim();
    if (!questionId || !questionText) continue;
    if (seenQuestions[questionId]) throw new Error('Дублирующийся ID вопроса: ' + questionId);
    seenQuestions[questionId] = true;
    if (iEnabled >= 0 && !checked(qd[r][iEnabled])) continue;
    ordered.push({ id: questionId, text: questionText });
  }

  var ad = sheet('Answers').getDataRange().getValues();
  var h = ad[0];
  var byId = {};
  for (var i = 1; i < ad.length; i++) {
    var answerId = normalizeQuestionId(ad[i][0]); if (!answerId) continue;
    if (byId[answerId]) throw new Error('Дублирующийся ID в Answers: ' + answerId);
    byId[answerId] = ad[i];
  }
  var iA = colIndex(h, 'Вариант A'), iB = colIndex(h, 'Вариант B'),
      iC = colIndex(h, 'Вариант C'), iD = colIndex(h, 'Вариант D'),
      iCorr = colIndex(h, 'Номер правильного ответа');
  var iTA = colIndex(h, 'Тег A'), iTB = colIndex(h, 'Тег B'),
      iTC = colIndex(h, 'Тег C'), iTD = colIndex(h, 'Тег D');

  var mascot = { attitude: 'neutral', interest: 'happy', knowledge: 'thinking', security: 'thinking', self: 'neutral' };
  function blockOf(id) {
    return { '1': 'attitude', '2': 'interest', '4': 'security' }[id.charAt(0)] || 'profile';
  }
  function isOwn(s) { return String(s || '').indexOf('вой вариант') >= 0; }
  function cell(row, index) { return index >= 0 ? row[index] : ''; }

  var out = [];
  ordered.forEach(function (source) {
    var row = byId[source.id];
    if (!row) throw new Error('Нет строки Answers для включенного вопроса: ' + source.id);
    var opts = [
      { key: 'A', text: cell(row, iA), tag: cell(row, iTA) },
      { key: 'B', text: cell(row, iB), tag: cell(row, iTB) },
      { key: 'C', text: cell(row, iC), tag: cell(row, iTC) },
      { key: 'D', text: cell(row, iD), tag: cell(row, iTD) },
    ];
    var correct = String(cell(row, iCorr) || '').trim();
    var selfTagged = opts.some(function (o) { return String(o.tag || '').indexOf('level-') === 0; });
    var blk = correct ? 'knowledge' : (selfTagged ? 'self' : blockOf(source.id));
    var q = { id: source.id, block: blk, mascot: mascot[blk] || 'neutral', text: source.text };
    if (correct) {
      q.type = 'knowledge';
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null; })
                      .map(function (o) { return { key: o.key, text: String(o.text) }; });
      q.correct = correct;
    } else if (selfTagged) {
      q.type = 'self';
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null; })
                      .map(function (o) { return { key: o.key, text: String(o.text), tag: String(o.tag || '') }; });
    } else {
      q.type = 'profile';
      q.allowOwn = opts.some(function (o) { return isOwn(o.text); });
      q.options = opts.filter(function (o) { return o.text !== '' && o.text != null && !isOwn(o.text); })
                      .map(function (o) { return { key: o.key, text: String(o.text), tag: String(o.tag || '') }; });
    }
    if (!q.options.length && !q.allowOwn) throw new Error('Нет вариантов ответа для включенного вопроса: ' + source.id);
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
    return syncEmployeeAnswers(p.id, p.answers, true);
  } finally { lock.releaseLock(); }
}

/* Вызывается только внутри script lock: один и тот же механизм используется
 * отдельным recovery-action и атомарной финализацией. */
function syncEmployeeAnswers(employeeId, rawAnswers, markPartial) {
  var incoming;
  try { incoming = JSON.parse(rawAnswers || '[]'); }
  catch (err) { return { ok: false, reason: 'invalid_answers' }; }
  if (!Array.isArray(incoming)) return { ok: false, reason: 'invalid_answers' };

  var allowed = {};
  getQuestions().forEach(function (q) { allowed[String(q.id)] = true; });
  var latest = {};
  incoming.forEach(function (item) {
    if (!item || item.questionId == null) return;
    var questionId = normalizeQuestionId(item.questionId);
    if (!allowed[questionId]) return;
    latest[questionId] = item.answer == null ? '' : item.answer;
  });

  var sh = sheet('Results');
  var data = sh.getDataRange().getValues();
  var existing = {};
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== String(employeeId)) continue;
    var existingId = normalizeQuestionId(data[r][1]);
    if (allowed[existingId]) existing[existingId] = r + 1;
  }

  var now = new Date();
  var append = [];
  var updated = 0;
  Object.keys(latest).forEach(function (questionId) {
    var row = existing[questionId];
    if (!row) {
      append.push([employeeId, questionId, latest[questionId], now]);
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
  if (markPartial !== false && Object.keys(latest).length) setUsage(employeeId, 'Частично', false);
  return { ok: true, saved: Object.keys(latest).length, appended: append.length, updated: updated };
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
      var questionId = normalizeQuestionId(data[r][1]);
      if (expected[questionId]) seen[questionId] = true;
    }
  }
  return Object.keys(seen).length;
}

/* --- Завершение -> «Использован» и сводка только после всех ответов. --- */
function finish(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (!hasEmployeeCredentials(p.id, p.code)) return { ok: false, reason: 'invalid_credentials' };
    var res;
    try { res = JSON.parse(p.results || '{}'); }
    catch (err) { return { ok: false, reason: 'invalid_results' }; }
    var synced = null;
    if (p.answers != null && p.answers !== '') {
      synced = syncEmployeeAnswers(p.id, p.answers, false);
      if (!synced.ok) return synced;
    }
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
    var summary = [
      ['Дата и время прохождения', new Date()],
      ['Процент правильных ответов', res.percentCorrect],
      ['Балл самооценки', res.selfScore],
      ['Средний балл на основе ответов', res.portraitScore],
      ['Принятие/готовность использовать ИИ', res.adoptionScore],
      ['Интерес и инициативность', res.interestScore],
      ['Безопасность и ответственность', res.safetyScore],
      ['Портрет', res.portraitLabel],
    ];
    var iUse = colIndex(h, 'Использование');
    if (iId < 0 || iUse < 0) return { ok: false, reason: 'employee_columns_missing' };
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][iId]) === String(p.id)) {
        var summaryIndexes = summary.map(function (item) { return colIndex(h, item[0]); });
        var contiguous = summaryIndexes.every(function (c, i) {
          return c >= 0 && (i === 0 || c === summaryIndexes[0] + i);
        });
        if (contiguous) {
          var summaryValues = summary.map(function (item, i) {
            return item[1] !== undefined && item[1] !== null ? item[1] : '';
          });
          sh.getRange(r + 1, summaryIndexes[0] + 1, 1, summaryValues.length).setValues([summaryValues]);
        } else {
          summary.forEach(function (item, i) {
            var c = summaryIndexes[i];
            if (c >= 0) sh.getRange(r + 1, c + 1).setValue(item[1] !== undefined && item[1] !== null ? item[1] : '');
          });
        }
        // Статус пишется последним: «Использован» означает, что итоги уже записаны.
        sh.getRange(r + 1, iUse + 1).setValue('Использован');
        return { ok: true, synced: synced };
      }
    }
    return { ok: false, reason: 'employee_not_found' };
  } finally { lock.releaseLock(); }
}
