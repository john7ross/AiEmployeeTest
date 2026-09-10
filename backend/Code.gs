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
 *   Questions : ID вопроса | Вопрос | Включен | Ограничение (по ID пользователя)
 *   Answers   : ID вопроса | Вариант A | B | C | D | Номер правильного ответа |
 *               Тег A | Тег B | Тег C | Тег D
 *   Results   : ID пользователя | ID вопроса | Ответ | Дата и время получения  (лог)
 *
 * ПЕРСОНАЛЬНЫЕ НАБОРЫ ВОПРОСОВ
 * ----------------------------
 * Колонка «Ограничение (по ID пользователя)» на листе Questions решает, кому
 * вопрос показывается. Пусто = всем (поведение по умолчанию не изменилось).
 *   2,5,7        только этим ID
 *   2-8          диапазон ID
 *   !5   -5      всем, кроме 5
 *   кроме 5, 7   всем, кроме 5 и 7   («кроме» действует до конца строки)
 *   2-8, !5      2,3,4,6,7,8
 *   все          явно всем;   никому — никому (вопрос де-факто выключен)
 * Регистр не важен, разделители — запятая, точка с запятой, перевод строки.
 *
 * Набор считается ОДИН раз на запрос и используется везде: выдача вопросов,
 * приём ответов (чужие отсекаются) и проверка полноты при завершении — иначе
 * человек с укороченным набором никогда не смог бы закончить опрос.
 *
 * Синтаксис обязан совпадать с parse_restriction() в survey_lib.py скилла
 * ai-survey-pulse — статистика разбирает эту же колонку.
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

/* =========================================================================
 * Ограничение вопроса по ID сотрудника
 * ========================================================================= */

var RESTRICTION_COLUMN = 'Ограничение (по ID пользователя)';
var RESTRICTION_ALL  = { 'все': 1, 'всем': 1, 'всё': 1, 'all': 1, '*': 1 };
var RESTRICTION_NONE = { 'никому': 1, 'никто': 1, 'нет': 1, 'none': 1, '-': 1 };

/* Разбор ячейки -> { include: {id:true}|null, exclude: {id:true}, none: bool, bad: [] }.
 * include === null означает «все, кроме exclude». */
function parseRestriction(raw) {
  var rule = { include: null, exclude: {}, none: false, raw: String(raw == null ? '' : raw).trim(), bad: [] };
  if (!rule.raw) return rule;

  var include = {};
  var hasInclude = false;
  var defaultNegate = false;   // «кроме» действует до конца строки
  var tokens = rule.raw.split(/[,;\n]+/);

  for (var i = 0; i < tokens.length; i++) {
    var t = String(tokens[i]).trim().toLowerCase();
    if (!t) continue;
    if (RESTRICTION_ALL[t]) { hasInclude = false; include = {}; continue; }
    if (RESTRICTION_NONE[t]) { rule.none = true; continue; }

    var negate = defaultNegate;
    var words = ['кроме', 'except', '!', '^'];
    for (var w = 0; w < words.length; w++) {
      if (t.indexOf(words[w]) === 0) {
        negate = true;
        if (words[w] === 'кроме' || words[w] === 'except') defaultNegate = true;
        t = t.slice(words[w].length).trim();
        break;
      }
    }
    if (!negate && /^[-–]\s*\d+$/.test(t)) { negate = true; t = t.replace(/^[-–]\s*/, ''); }

    var ids = restrictionTokenIds(t);
    if (!ids) { rule.bad.push(String(tokens[i]).trim()); continue; }
    for (var k = 0; k < ids.length; k++) {
      if (negate) rule.exclude[ids[k]] = true;
      else { include[ids[k]] = true; hasInclude = true; }
    }
  }
  if (hasInclude) rule.include = include;
  return rule;
}

/* '5' -> [5];  '2-8' -> [2..8];  иначе null. */
function restrictionTokenIds(t) {
  var range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(t);
  if (range) {
    var lo = parseInt(range[1], 10), hi = parseInt(range[2], 10);
    if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
    if (hi - lo > 10000) return null;
    var out = [];
    for (var i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  if (/^\d+$/.test(t)) return [parseInt(t, 10)];
  return null;
}

function restrictionAllows(rule, employeeId) {
  if (!rule) return true;
  if (rule.none) return false;
  var id = parseInt(String(employeeId), 10);
  if (!isFinite(id)) return rule.include === null;
  if (rule.exclude[id]) return false;
  return rule.include === null ? true : !!rule.include[id];
}

/* =========================================================================
 * Сотрудники
 * ========================================================================= */

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
    if (isExcluded(usage)) return false;
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
        if (isExcluded(usage)) return { valid: false, reason: 'excluded' };
        if (usage.toLowerCase() === 'использован') return { valid: false, reason: 'used' };
        var timer = iTimer < 0 ? { enabled: true, seconds: getDefaultTimerSeconds() }
                                : parseTimerCell(data[r][iTimer]);
        return {
          valid: true, id: data[r][iId], fio: data[r][iFio], usage: usage,
          timerEnabled: timer.enabled, timerSeconds: timer.seconds
        };
      }
    }
    return { valid: false, reason: 'not_found' };
  } finally { lock.releaseLock(); }
}

/* --- Весь опрос из таблицы: только после повторной проверки ID + токена. --- */
function getSurvey(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  var questions = getQuestions(p.id);
  if (!questions.length) return { ok: false, error: 'no_active_questions' };
  return { ok: true, questions: questions, principles: getPrinciples(),
           prompt: getSetting('prompt'), minAnswers: getMinAnswers() };
}

/* Старый отдельный action тоже не должен раскрывать вопросы без авторизации. */
function getQuestionsForEmployee(p) {
  if (!hasActiveEmployeeCredentials(p.id, p.code)) return { ok: false, error: 'unauthorized' };
  var questions = getQuestions(p.id);
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

/* =========================================================================
 * «НЕ УЧАСТВУЕТ» — сотрудник остаётся в таблице, но выпадает из волны
 *
 * Третье значение колонки «Использование». Ставится тем, кто ушёл из отдела
 * или по любой причине не проходит опросы. Такой человек:
 *   - не может войти по своему токену;
 *   - не сбрасывается и не архивируется при startNewWave();
 *   - не попадает ни в участников, ни в список «не прошли» у аналитики.
 *
 * Строку при этом НЕ удаляют: на ID сотрудника завязаны его ответы в Results,
 * архив прошлых волн в Employees_history и отметки на листе Usages. Удалённая
 * строка уносит человека из разбора прошлых волн, хотя архив никуда не делся.
 * ========================================================================= */
var EXCLUDED_STATUS = 'Не участвует';

function isExcluded(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === EXCLUDED_STATUS.toLowerCase();
}

/* =========================================================================
 * ТАЙМЕР БЛИЦ-ВОПРОСОВ
 * Живёт в таблице, а не в коде фронтенда. Значение по умолчанию —
 * Settings > timer_seconds. Персональное — колонка «Таймер» в Employees:
 *
 *   пусто или TRUE     столько секунд, сколько задано по умолчанию
 *   FALSE, «нет», 0    без таймера, предупреждение тоже не показывается
 *   число              столько секунд именно этому сотруднику
 *
 * Так одному можно дать 40 секунд, другому 90, третьему снять ограничение,
 * и всё это без правки кода и без публикации фронтенда.
 * ========================================================================= */
var TIMER_SECONDS_FALLBACK = 40;

function getDefaultTimerSeconds() {
  var n = parseInt(String(getSetting('timer_seconds') || '').trim(), 10);
  return isFinite(n) && n > 0 ? n : TIMER_SECONDS_FALLBACK;
}

function parseTimerCell(value) {
  var def = getDefaultTimerSeconds();
  if (value === true) return { enabled: true, seconds: def };
  if (value === false) return { enabled: false, seconds: 0 };
  var raw = String(value == null ? '' : value).trim().toLowerCase();
  if (raw === '') return { enabled: true, seconds: def };
  if (raw === 'true' || raw === 'да') return { enabled: true, seconds: def };
  if (raw === 'false' || raw === 'нет' || raw === '0') return { enabled: false, seconds: 0 };
  var n = parseInt(raw, 10);
  return isFinite(n) && n > 0 ? { enabled: true, seconds: n } : { enabled: true, seconds: def };
}

/* Минимум ответов на характеристику. ЕДИНЫЙ ИСТОЧНИК — лист Settings, строка
 * `min_answers` со значением-JSON: {"adoption":6,"interest":6,"safety":4}.
 * Отдаётся фронтенду в getSurvey и используется в auditQuestionSets, чтобы
 * порог не разъезжался между js/config.js, бэкендом и статистикой скилла.
 * Если строки нет — берутся значения ниже (как в js/config.js). */
var MIN_ANSWERS_FALLBACK = { adoption: 6, interest: 6, safety: 4 };

/* =========================================================================
 * ВОЛНЫ
 * Номер текущей волны — Settings ▸ wave (по умолчанию 1). Он пишется в колонку
 * «Волна» листа Results, и вся работа с ответами идёт ТОЛЬКО в пределах текущей
 * волны: строки прошлых волн не читаются, не обновляются и не мешают завершению.
 * Без колонки «Волна» всё работает как раньше (одна общая куча ответов).
 * ========================================================================= */
var WAVE_COLUMN = 'Волна';

function getWave() {
  var raw = String(getSetting('wave') || '').trim();
  var n = parseInt(raw, 10);
  return isFinite(n) && n > 0 ? n : 1;
}

/* Индексы колонок Results + позиция «Волны» (-1, если колонки нет). */
function resultsMeta() {
  var sh = sheet('Results');
  var last = sh.getLastColumn();
  var head = last ? sh.getRange(1, 1, 1, last).getValues()[0] : [];
  return { sheet: sh, head: head, iWave: colIndex(head, WAVE_COLUMN), width: Math.max(last, 4) };
}

/* Строка Results относится к волне w? Без колонки — считаем, что да. */
function rowInWave(row, iWave, wave) {
  if (iWave < 0) return true;
  var v = row[iWave];
  if (v === '' || v == null) return wave === 1;   // строки до внедрения колонки = волна 1
  return parseInt(String(v), 10) === wave;
}

function resultRow(employeeId, questionId, answer, when, iWave, wave, width) {
  var row = [employeeId, questionId, answer, when];
  while (row.length < width) row.push('');
  if (iWave >= 0) row[iWave] = wave;
  return row;
}

function getMinAnswers() {
  var raw = String(getSetting('min_answers') || '').trim();
  if (!raw) return MIN_ANSWERS_FALLBACK;
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error('Settings ▸ min_answers: не разобрался JSON «' + raw + '»'); }
  var out = {};
  Object.keys(MIN_ANSWERS_FALLBACK).forEach(function (k) {
    var v = parseInt(parsed[k], 10);
    out[k] = isFinite(v) && v >= 0 ? v : MIN_ANSWERS_FALLBACK[k];
  });
  return out;
}

/* --- Вопросы: Questions (текст + ограничение) + Answers (варианты/правильный/теги).
 *
 * employeeId необязателен: без него возвращается полный включённый набор
 * (каркас волны). С ним — персональный набор этого сотрудника.
 * -------------------------------------------------------------------------- */
function getQuestions(employeeId) {
  var qd = sheet('Questions').getDataRange().getValues();
  var qh = qd[0] || [];
  var iQId = colIndex(qh, 'ID вопроса'), iQText = colIndex(qh, 'Вопрос');
  var iEnabled = colIndex(qh, 'Включен');
  if (iEnabled < 0) iEnabled = colIndex(qh, 'Включить');
  if (iEnabled < 0) iEnabled = colIndex(qh, 'Включено');
  var iLimit = colIndex(qh, RESTRICTION_COLUMN);
  if (iLimit < 0) iLimit = colIndex(qh, 'Ограничение');
  if (iQId < 0 || iQText < 0) return [];
  var restrict = employeeId !== undefined && employeeId !== null && employeeId !== '';

  var ordered = [];
  var seenQuestions = {};
  for (var r = 1; r < qd.length; r++) {
    var questionId = normalizeQuestionId(qd[r][iQId]);
    var questionText = String(qd[r][iQText] || '').trim();
    if (!questionId || !questionText) continue;
    if (seenQuestions[questionId]) throw new Error('Дублирующийся ID вопроса: ' + questionId);
    seenQuestions[questionId] = true;
    if (iEnabled >= 0 && !checked(qd[r][iEnabled])) continue;
    if (iLimit >= 0) {
      var rule = parseRestriction(qd[r][iLimit]);
      if (rule.bad.length) {
        throw new Error('Вопрос ' + questionId + ': непонятное ограничение «' + rule.bad.join(', ') +
                        '». Допустимо: 2,5,7 / 2-8 / !5 / кроме 5,7 / все / никому');
      }
      if (restrict && !restrictionAllows(rule, employeeId)) continue;
      if (!restrict && rule.none) continue;
    }
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
    var m = resultsMeta();
    m.sheet.appendRow(resultRow(p.id, p.questionId, p.answer == null ? '' : p.answer,
                                new Date(), m.iWave, getWave(), m.width));
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
 * отдельным recovery-action и атомарной финализацией.
 * allowed строится по ПЕРСОНАЛЬНОМУ набору: ответ на вопрос, который этому
 * человеку не показывали, в таблицу не попадёт. */
function syncEmployeeAnswers(employeeId, rawAnswers, markPartial) {
  var incoming;
  try { incoming = JSON.parse(rawAnswers || '[]'); }
  catch (err) { return { ok: false, reason: 'invalid_answers' }; }
  if (!Array.isArray(incoming)) return { ok: false, reason: 'invalid_answers' };

  var allowed = {};
  getQuestions(employeeId).forEach(function (q) { allowed[String(q.id)] = true; });
  var latest = {};
  incoming.forEach(function (item) {
    if (!item || item.questionId == null) return;
    var questionId = normalizeQuestionId(item.questionId);
    if (!allowed[questionId]) return;
    latest[questionId] = item.answer == null ? '' : item.answer;
  });

  var m = resultsMeta();
  var sh = m.sheet;
  var wave = getWave();
  var data = sh.getDataRange().getValues();
  var existing = {};
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== String(employeeId)) continue;
    if (!rowInWave(data[r], m.iWave, wave)) continue;   // прошлые волны не трогаем
    var existingId = normalizeQuestionId(data[r][1]);
    if (allowed[existingId]) existing[existingId] = r + 1;
  }

  var now = new Date();
  var append = [];
  var updated = 0;
  Object.keys(latest).forEach(function (questionId) {
    var row = existing[questionId];
    if (!row) {
      append.push(resultRow(employeeId, questionId, latest[questionId], now, m.iWave, wave, m.width));
      return;
    }
    var current = data[row - 1][2] == null ? '' : data[row - 1][2];
    if (String(current) !== String(latest[questionId])) {
      sh.getRange(row, 3, 1, 2).setValues([[latest[questionId], now]]);
      updated += 1;
    }
  });
  if (append.length) {
    sh.getRange(sh.getLastRow() + 1, 1, append.length, append[0].length).setValues(append);
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
    if (isExcluded(current)) return false;   // выведенного из волны не возвращаем в неё записью ответа
    if (overwriteUsed || current !== 'использован') sh.getRange(r + 1, iUse + 1).setValue(value);
    return true;
  }
  return false;
}

/* Считаем только ответы ТЕКУЩЕЙ волны: иначе прошлогодний ответ на тот же вопрос
 * закрыл бы требование полноты, и сотрудник «завершил» бы опрос, не отвечая. */
function answeredQuestionCount(employeeId, expectedIds) {
  var m = resultsMeta();
  var wave = getWave();
  var data = m.sheet.getDataRange().getValues();
  var expected = {};
  expectedIds.forEach(function (id) { expected[String(id)] = true; });
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== String(employeeId)) continue;
    if (data[r][1] === '' || data[r][1] == null) continue;
    if (!rowInWave(data[r], m.iWave, wave)) continue;
    var questionId = normalizeQuestionId(data[r][1]);
    if (expected[questionId]) seen[questionId] = true;
  }
  return Object.keys(seen).length;
}

/* --- Завершение -> «Использован» и сводка только после всех ответов.
 * Полнота проверяется по персональному набору: у человека с укороченным
 * набором «все ответы» — это его вопросы, а не весь список волны. --- */
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
    var questions = getQuestions(p.id);
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

/* =========================================================================
 * ПЕРЕЗАПУСК ВОЛНЫ
 *
 * setupWaveColumn()  — один раз: добавляет в Results колонку «Волна» и
 *                      проставляет существующим строкам номер текущей волны.
 * previewNewWave()   — показывает, что изменит startNewWave, ничего не трогая.
 * startNewWave()     — архивирует итоги в лист Employees_history, очищает итоги
 *                      в Employees, ставит «Не использован» и увеличивает
 *                      Settings ▸ wave на единицу.
 *
 * Лист Results startNewWave НЕ ТРОГАЕТ: ответы прошлых волн остаются на месте,
 * новые лягут ниже с новым номером волны.
 * Галки «Включен» у вопросов переключаются руками — это редакторское решение.
 * ========================================================================= */

var HISTORY_SHEET = 'Employees_history';
var SUMMARY_COLUMNS = [
  'Дата и время прохождения', 'Процент правильных ответов', 'Балл самооценки',
  'Средний балл на основе ответов', 'Принятие/готовность использовать ИИ',
  'Интерес и инициативность', 'Безопасность и ответственность', 'Портрет'
];

function setSetting(key, value) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Settings');
  if (!sh) throw new Error('Лист "Settings" не найден');
  var data = sh.getDataRange().getValues();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][0]).trim() === key) { sh.getRange(r + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function setupWaveColumn() {
  var sh = sheet('Results');
  var last = sh.getLastColumn();
  var head = last ? sh.getRange(1, 1, 1, last).getValues()[0] : [];
  if (colIndex(head, WAVE_COLUMN) >= 0) return 'Колонка «' + WAVE_COLUMN + '» уже есть, ничего не делаю.';
  var col = last + 1;
  sh.getRange(1, col).setValue(WAVE_COLUMN);
  var rows = sh.getLastRow() - 1;
  var wave = getWave();
  if (rows > 0) {
    var fill = [];
    for (var i = 0; i < rows; i++) fill.push([wave]);
    sh.getRange(2, col, rows, 1).setValues(fill);
  }
  var msg = 'Добавил колонку «' + WAVE_COLUMN + '» (столбец ' + col + '), проставил волну ' +
            wave + ' в ' + rows + ' строк.';
  Logger.log(msg);
  return msg;
}

function previewNewWave() { return newWave_(true); }
function startNewWave()   { return newWave_(false); }

function newWave_(dryRun) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var wave = getWave();
    var sh = sheet('Employees');
    var data = sh.getDataRange().getValues();
    var h = data[0];
    var iId = colIndex(h, 'ID'), iFio = colIndex(h, 'ФИО'),
        iDept = colIndex(h, 'Отдел'), iRole = colIndex(h, 'Должность'),
        iUse = colIndex(h, 'Использование');
    if (iId < 0 || iUse < 0) throw new Error('Employees: нет колонок ID / Использование');

    var cols = SUMMARY_COLUMNS.map(function (name) { return colIndex(h, name); });
    var missing = SUMMARY_COLUMNS.filter(function (name, i) { return cols[i] < 0; });
    if (missing.length) throw new Error('Employees: нет колонок ' + missing.join(', '));

    var m = resultsMeta();
    if (m.iWave < 0) {
      throw new Error('В Results нет колонки «' + WAVE_COLUMN + '». Сначала запустите setupWaveColumn(), ' +
                      'иначе ответы новой волны перемешаются с прошлой.');
    }

    var archive = [], reset = [], lines = [];
    for (var r = 1; r < data.length; r++) {
      var id = data[r][iId];
      if (id === '' || id == null) continue;
      var status = String(data[r][iUse]).trim().toLowerCase();
      var finished = status === 'использован';
      if (!finished && status !== 'частично') continue;
      if (finished) {
        archive.push([wave, id, data[r][iFio], iDept >= 0 ? data[r][iDept] : '', iRole >= 0 ? data[r][iRole] : '']
          .concat(cols.map(function (c) { return data[r][c]; }))
          .concat([new Date()]));
      }
      reset.push(r + 1);
      lines.push('  #' + id + ' ' + data[r][iFio] + (finished ? ' — итоги в архив, статус сброшен' : ' — был «Частично», статус сброшен'));
    }

    var head = ['Волна', 'ID', 'ФИО', 'Отдел', 'Должность'].concat(SUMMARY_COLUMNS).concat(['Архивировано']);
    var report = ['Волна ' + wave + ' -> ' + (wave + 1),
                  'В архив: ' + archive.length + ' чел., статус сбросится у ' + reset.length + ' чел.'];
    report = report.concat(lines);
    report.push('Лист Results не трогается: ответы волны ' + wave + ' остаются, новые лягут с номером ' + (wave + 1) + '.');

    if (dryRun) {
      report.unshift('РЕЖИМ ПРОСМОТРА — ничего не изменено. Запустите startNewWave(), чтобы применить.');
      var preview = report.join('\n');
      Logger.log(preview);
      return preview;
    }

    var hist = SpreadsheetApp.getActive().getSheetByName(HISTORY_SHEET);
    if (!hist) {
      hist = SpreadsheetApp.getActive().insertSheet(HISTORY_SHEET);
      hist.appendRow(head);
      hist.setFrozenRows(1);
    }
    if (archive.length) {
      hist.getRange(hist.getLastRow() + 1, 1, archive.length, head.length).setValues(archive);
    }
    reset.forEach(function (row) {
      cols.forEach(function (c) { sh.getRange(row, c + 1).setValue(''); });
      sh.getRange(row, iUse + 1).setValue('Не использован');
    });
    setSetting('wave', wave + 1);

    report.unshift('ГОТОВО.');
    report.push('Теперь: снимите галки «Включен» со старых вопросов, поставьте новым — и рассылайте.');
    var done = report.join('\n');
    Logger.log(done);
    return done;
  } finally { lock.releaseLock(); }
}

/* =========================================================================
 * ПРОВЕРКА ПЕРЕД ЗАПУСКОМ ВОЛНЫ
 * Запустить руками в редакторе Apps Script (Run ▸ auditQuestionSets) и
 * посмотреть Execution log. Показывает, кто сколько вопросов получит и у кого
 * набор стал короче минимума для характеристики — у таких людей балл и портрет
 * не посчитаются (js/config.js -> portrait.dimensions.minAnswers).
 * Списки вопросов ниже должны совпадать с portrait.scores в js/config.js.
 * ========================================================================= */

var AUDIT_DIMENSIONS = {
  adoption: ['101','102','104','106','107','108','109','110'],
  interest: ['201','202','203','205','207','208','209','210'],
  safety:   ['103','105','108','110','411'],
};

function auditQuestionSets() {
  var sh = sheet('Employees');
  var data = sh.getDataRange().getValues();
  var h = data[0];
  var iId = colIndex(h, 'ID'), iFio = colIndex(h, 'ФИО');
  var iUseAudit = colIndex(h, 'Использование');
  var mins = getMinAnswers();
  var lines = [];
  var problems = [];
  lines.push('Полный набор волны: ' + getQuestions().length + ' вопр.');
  lines.push('Минимум ответов на характеристику (Settings ▸ min_answers): ' + JSON.stringify(mins));

  for (var r = 1; r < data.length; r++) {
    var id = data[r][iId];
    if (id === '' || id == null) continue;
    // Пустая строка с одним ID — не сотрудник, см. validateSurvey.
    if (iFio >= 0 && String(data[r][iFio] == null ? '' : data[r][iFio]).trim() === '') continue;
    if (iUseAudit >= 0 && isExcluded(data[r][iUseAudit])) continue;
    var ids = getQuestions(id).map(function (q) { return q.id; });
    var have = {};
    ids.forEach(function (q) { have[q] = true; });
    var short = [];
    Object.keys(AUDIT_DIMENSIONS).forEach(function (dim) {
      var n = AUDIT_DIMENSIONS[dim].filter(function (q) { return have[q]; }).length;
      if (n < mins[dim]) short.push(dim + ' ' + n + '/' + mins[dim]);
    });
    var line = '#' + id + ' ' + data[r][iFio] + ' — ' + ids.length + ' вопр.';
    if (short.length) {
      line += '   ⚠ не хватит на: ' + short.join(', ');
      problems.push(line);
    }
    lines.push(line);
  }
  if (problems.length) {
    lines.push('');
    lines.push('ВНИМАНИЕ: у ' + problems.length + ' чел. набор короче минимума — портрет останется пустым.');
    lines.push('Либо верните вопросы, либо снизьте min_answers на листе Settings.');
  }
  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

/* =========================================================================
 * ВАЛИДАЦИЯ ТАБЛИЦЫ ПЕРЕД ЗАПУСКОМ ВОЛНЫ
 * Run ▸ validateSurvey, смотреть Execution log. Ловит то, что иначе всплывёт
 * у сотрудника в момент прохождения: дубли, пропущенные строки Answers,
 * повторяющиеся токены, битые ограничения.
 * ========================================================================= */
function validateSurvey() {
  var problems = [];
  var warnings = [];

  // --- Questions ---
  var qd = sheet('Questions').getDataRange().getValues();
  var qh = qd[0] || [];
  var iQId = colIndex(qh, 'ID вопроса'), iQText = colIndex(qh, 'Вопрос');
  var iEnabled = colIndex(qh, 'Включен');
  var iLimit = colIndex(qh, RESTRICTION_COLUMN);
  if (iQId < 0 || iQText < 0) problems.push('Questions: нет колонок «ID вопроса» / «Вопрос»');
  var seenQ = {}, enabled = [];
  for (var r = 1; r < qd.length; r++) {
    var qid = normalizeQuestionId(qd[r][iQId]);
    var text = String(qd[r][iQText] || '').trim();
    if (!qid && !text) continue;
    if (!qid) { problems.push('Questions, строка ' + (r + 1) + ': есть текст, но нет ID'); continue; }
    if (!text) { problems.push('Questions, вопрос ' + qid + ': пустой текст'); continue; }
    if (seenQ[qid]) problems.push('Questions: ID ' + qid + ' встречается дважды');
    seenQ[qid] = true;
    if (iLimit >= 0) {
      var rule = parseRestriction(qd[r][iLimit]);
      if (rule.bad.length) problems.push('Questions, вопрос ' + qid + ': непонятное ограничение «' + rule.bad.join(', ') + '»');
      if (rule.none) warnings.push('вопрос ' + qid + ' не увидит никто (ограничение «никому»)');
    }
    if (iEnabled < 0 || checked(qd[r][iEnabled])) enabled.push(qid);
  }
  if (!enabled.length) problems.push('Questions: нет ни одного включённого вопроса');

  // --- Answers ---
  var ad = sheet('Answers').getDataRange().getValues();
  var ah = ad[0] || [];
  var iA = colIndex(ah, 'Вариант A'), iCorr = colIndex(ah, 'Номер правильного ответа');
  var seenA = {}, byId = {};
  for (var i = 1; i < ad.length; i++) {
    var aid = normalizeQuestionId(ad[i][0]);
    if (!aid) continue;
    if (seenA[aid]) problems.push('Answers: ID ' + aid + ' встречается дважды');
    seenA[aid] = true;
    byId[aid] = ad[i];
  }
  enabled.forEach(function (qid) {
    var row = byId[qid];
    if (!row) { problems.push('Answers: нет строки для включённого вопроса ' + qid); return; }
    if (iA >= 0 && String(row[iA] || '').trim() === '') problems.push('Answers, вопрос ' + qid + ': пустой «Вариант A»');
    var corr = iCorr >= 0 ? String(row[iCorr] || '').trim() : '';
    if (corr && ['A','B','C','D'].indexOf(corr) < 0) {
      problems.push('Answers, вопрос ' + qid + ': «Номер правильного ответа» = «' + corr + '», ожидается A/B/C/D');
    }
  });

  // --- Employees ---
  var ed = sheet('Employees').getDataRange().getValues();
  var eh = ed[0] || [];
  var iId = colIndex(eh, 'ID'), iFio = colIndex(eh, 'ФИО'), iTok = colIndex(eh, 'Токен');
  var iUseV = colIndex(eh, 'Использование');
  var seenId = {}, seenTok = {}, active = 0, excluded = [];
  for (var r2 = 1; r2 < ed.length; r2++) {
    var id = String(ed[r2][iId] == null ? '' : ed[r2][iId]).trim();
    var fio = String(ed[r2][iFio] == null ? '' : ed[r2][iFio]).trim();
    var tok = String(ed[r2][iTok] == null ? '' : ed[r2][iTok]).trim();
    // Сотрудник — это строка, где есть ФИО или токен. Строка, в которой остался
    // один ID (протянутая вниз разметка), сотрудником не считается: иначе проверка
    // тонет в сотнях ложных «нет ФИО» и настоящие ошибки в ней не видно.
    if (!fio && !tok) continue;
    if (!id) { problems.push('Employees, строка ' + (r2 + 1) + ' (' + fio + '): нет ID'); continue; }
    if (!fio) problems.push('Employees, ID ' + id + ': нет ФИО');
    if (seenId[id]) problems.push('Employees: ID ' + id + ' встречается дважды');
    seenId[id] = true;
    // Выведенный из волны в число активных не идёт и об отсутствии токена по нему
    // не предупреждаем. Но его токен всё равно проверяем на совпадение: одинаковый
    // токен у выведенного и у действующего заблокировал бы вход действующему —
    // validateCode отдаёт первую попавшуюся строку с этим токеном.
    var isOut = isExcluded(ed[r2][iUseV]);
    if (isOut) excluded.push(id + ' ' + fio);
    if (!tok) {
      if (!isOut) warnings.push('ID ' + id + ' (' + fio + ') без токена — опрос пройти не сможет');
      continue;
    }
    if (seenTok[tok]) problems.push('Employees: токен ID ' + id + ' совпадает с токеном ID ' + seenTok[tok]);
    seenTok[tok] = id;
    if (isOut) continue;
    active++;
  }

  // --- Usages (связка по ID) ---
  var ush = SpreadsheetApp.getActive().getSheetByName('Usages');
  if (ush) {
    var ud = ush.getDataRange().getValues();
    var uh = ud[0] || [];
    var iUid = colIndex(uh, 'ID');
    if (iUid < 0) {
      warnings.push('Usages: нет колонки ID — статистика вовлечённости не свяжется с сотрудниками');
    } else {
      for (var r3 = 1; r3 < ud.length; r3++) {
        var uid = String(ud[r3][iUid] == null ? '' : ud[r3][iUid]).trim();
        var ufio = String(ud[r3][1] == null ? '' : ud[r3][1]).trim();
        if (!uid && !ufio) continue;
        if (!uid) { warnings.push('Usages: строка «' + ufio + '» без ID — не попадёт в статистику'); continue; }
        if (!seenId[String(parseInt(uid, 10))]) warnings.push('Usages: ID ' + uid + ' («' + ufio + '») нет в Employees');
      }
    }
  }

  if (excluded.length) {
    warnings.push('Не участвуют в волне (' + excluded.length + '): ' + excluded.join('; '));
  }

  // --- Settings и волны ---
  var timerRaw = String(getSetting('timer_seconds') || '').trim();
  if (timerRaw === '') {
    warnings.push('Settings: нет строки timer_seconds — таймер блица будет ' + TIMER_SECONDS_FALLBACK + ' сек.');
  } else if (!(parseInt(timerRaw, 10) > 0)) {
    problems.push('Settings ▸ timer_seconds = «' + timerRaw + '», ожидается число секунд больше нуля');
  }

  try { getMinAnswers(); } catch (err) { problems.push(String(err.message || err)); }
  if (!String(getSetting('prompt') || '').trim()) warnings.push('Settings: пустой prompt — сотруднику нечего будет скопировать');
  var wave = getWave();
  var meta = resultsMeta();
  if (meta.iWave < 0) {
    warnings.push('Results: нет колонки «' + WAVE_COLUMN + '» — ответы новой волны перезапишут прошлые. ' +
                  'Запустите setupWaveColumn() один раз.');
  } else {
    var rd = meta.sheet.getDataRange().getValues();
    var blanks = 0, future = 0;
    for (var r4 = 1; r4 < rd.length; r4++) {
      if (rd[r4][0] === '' || rd[r4][0] == null) continue;
      var w = rd[r4][meta.iWave];
      if (w === '' || w == null) blanks++;
      else if (parseInt(String(w), 10) > wave) future++;
    }
    if (blanks) warnings.push('Results: ' + blanks + ' строк без номера волны — считаются волной 1');
    if (future) problems.push('Results: ' + future + ' строк с номером волны больше текущей (' + wave + ')');
  }
  if (!String(getSetting('wave') || '').trim()) {
    warnings.push('Settings: нет строки wave — работаем как волна 1');
  }

  var out = [];
  out.push('Текущая волна: ' + wave + ' | включённых вопросов: ' + enabled.length +
           ' | сотрудников с токеном: ' + active);
  out.push(problems.length ? '\nОШИБКИ (' + problems.length + ') — опрос сломается:' : '\nОшибок нет.');
  problems.forEach(function (p) { out.push('  ✖ ' + p); });
  if (warnings.length) {
    out.push('\nПредупреждения (' + warnings.length + '):');
    warnings.forEach(function (w) { out.push('  ! ' + w); });
  }
  var report = out.join('\n');
  Logger.log(report);
  return report;
}
