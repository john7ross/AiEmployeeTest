const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

class MockSheet {
  constructor(values) { this.values = values; this.writes = []; }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  getRange(row, col, rows = 1, cols = 1) {
    const sheet = this;
    return {
      getValues() {
        return Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => sheet.values[row - 1 + r]?.[col - 1 + c] ?? ''));
      },
      setValue(value) {
        while (sheet.values.length < row) sheet.values.push([]);
        sheet.values[row - 1][col - 1] = value;
        sheet.writes.push({ row, col, values: [[value]] });
      },
      setValues(values) {
        for (let r = 0; r < rows; r += 1) {
          while (sheet.values.length < row + r) sheet.values.push([]);
          for (let c = 0; c < cols; c += 1) {
            sheet.values[row - 1 + r][col - 1 + c] = values[r][c];
          }
        }
        sheet.writes.push({ row, col, values: values.map((line) => line.slice()) });
      },
    };
  }
  getLastColumn() { return Math.max(0, ...this.values.map((row) => row.length)); }
  getLastRow() { return this.values.length; }
  appendRow(row) { this.values.push(row.slice()); }
}

function questionIds() {
  return [
    '511',
    ...Array.from({ length: 10 }, (_, i) => String(101 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(201 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(301 + i)),
    '411',
  ];
}

function createBackendContext() {
  const ids = questionIds();
  const questionText = { '511': 'Self', '411': 'Security' };
  for (let i = 0; i < 10; i += 1) {
    questionText[String(101 + i)] = `A${i}`;
    questionText[String(201 + i)] = `I${i}`;
    questionText[String(301 + i)] = `K${i}`;
  }
  const questions = [['ID вопроса', 'Вопрос', 'Включен']];
  for (const id of ids) questions.push([Number(id), questionText[id], true]);
  questions.push([999, 'Скрытый старый вопрос', false]);

  const answers = [['ID вопроса', 'Вариант A', 'Вариант B', 'Вариант C', 'Вариант D', 'Номер правильного ответа', 'Тег A', 'Тег B', 'Тег C', 'Тег D']];
  for (const id of ids) {
    const tags = id === '511' ? ['level-0', 'level-1', 'level-2', 'level-3'] : ['neutral', 'neutral', 'neutral', 'neutral'];
    answers.push([Number(id), 'A', 'B', 'C', 'D', id[0] === '3' ? 'A' : '', ...tags]);
  }
  answers.push([999, 'A', 'B', 'C', 'D', '', 'neutral', 'neutral', 'neutral', 'neutral']);

  const sheets = {
    Employees: new MockSheet([
      ['ID', 'ФИО', 'Отдел', 'Должность', 'Токен', 'Использование', 'Дата и время прохождения', 'Процент правильных ответов', 'Балл самооценки', 'Средний балл на основе ответов', 'Принятие/готовность использовать ИИ', 'Интерес и инициативность', 'Безопасность и ответственность', 'Портрет', 'Таймер'],
      [1, 'Тестовый Сотрудник', 'Отдел', 'Роль', 'TOKEN-1', 'Не использован', '', '', '', '', '', '', '', '', true],
      [2, 'Без таймера', 'Отдел', 'Роль', 'TOKEN-2', 'Не использован', '', '', '', '', '', '', '', '', false],
    ]),
    Questions: new MockSheet(questions),
    Answers: new MockSheet(answers),
    Results: new MockSheet([['ID пользователя', 'ID вопроса', 'Ответ', 'Дата и время получения']]),
    Principles: new MockSheet([['Принцип']]),
    Settings: new MockSheet([['prompt', 'Prompt']]),
  };

  const lock = { waitLock() {}, releaseLock() {} };
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Object,
    String,
    parseInt,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: (name) => sheets[name] || null }) },
    LockService: { getScriptLock: () => lock },
    ContentService: {
      MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
      createTextOutput: () => ({ setMimeType() { return this; } }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'backend', 'Code.gs'), 'utf8'), context);
  return { context, sheets, ids };
}

function employeeUsage(sheets) { return sheets.Employees.values[1][5]; }

function testBackendLifecycle() {
  const { context, sheets, ids } = createBackendContext();

  assert.deepEqual(JSON.parse(JSON.stringify(context.validateCode('TOKEN-1'))), {
    valid: true, id: 1, fio: 'Тестовый Сотрудник', usage: 'Не использован', timerEnabled: true,
  });
  assert.equal(context.validateCode('TOKEN-2').timerEnabled, false, 'снятый чекбокс отключает таймер');
  const legacy = createBackendContext();
  legacy.sheets.Employees.values.forEach((row) => row.pop());
  assert.equal(legacy.context.validateCode('TOKEN-1').timerEnabled, true, 'без колонки сохраняется прежний таймер');
  assert.equal(employeeUsage(sheets), 'Не использован', 'вход не должен менять статус');

  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({}))), { ok: false, error: 'unauthorized' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({ id: 1, code: 'WRONG' }))), { ok: false, error: 'unauthorized' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({ id: 2, code: 'TOKEN-1' }))), { ok: false, error: 'unauthorized' });
  const authorizedSurvey = context.getSurvey({ id: 1, code: 'TOKEN-1' });
  assert.equal(authorizedSurvey.ok, true);
  assert.equal(authorizedSurvey.questions.length, 32);
  assert.deepEqual(JSON.parse(JSON.stringify(authorizedSurvey.questions.map((q) => q.id))), ids, 'порядок берётся из строк Questions');
  assert.equal(authorizedSurvey.questions[0].type, 'self', 'теги level-* определяют самооценку');
  assert.equal(authorizedSurvey.questions.find((q) => q.id === '301').type, 'knowledge');
  assert.equal(authorizedSurvey.questions.some((q) => q.id === '999'), false, 'снятый флажок исключает вопрос');
  assert.equal(context.getQuestionsForEmployee({}).error, 'unauthorized');
  assert.equal(context.getQuestionsForEmployee({ id: 1, code: 'TOKEN-1' }).questions.length, 32);

  const dynamic = createBackendContext();
  dynamic.sheets.Questions.values[2][2] = false; // 101 выключен
  dynamic.sheets.Questions.values.push(['NEW-A', 'Новый обычный вопрос', true]);
  dynamic.sheets.Answers.values.push(['NEW-A', 'Да', 'Нет', '', '', '', 'neutral', 'neutral', '', '']);
  dynamic.sheets.Questions.values.push([901, 'Новый вопрос со знанием', true]);
  dynamic.sheets.Answers.values.push([901, 'A', 'B', 'C', 'D', 'D', '', '', '', '']);
  const dynamicQuestions = dynamic.context.getQuestions();
  assert.equal(dynamicQuestions.some((q) => q.id === '101'), false);
  assert.equal(dynamicQuestions.at(-2).id, 'NEW-A');
  assert.equal(dynamicQuestions.at(-2).type, 'profile');
  assert.equal(dynamicQuestions.at(-1).id, '901');
  assert.equal(dynamicQuestions.at(-1).type, 'knowledge', 'правильный ответ определяет блиц независимо от префикса ID');
  dynamic.sheets.Questions.values[0][2] = 'Включить';
  assert.equal(dynamic.context.getQuestions().length, dynamicQuestions.length, 'поддерживается заголовок Включить');

  const nextSurvey = createBackendContext();
  nextSurvey.sheets.Questions.values.slice(1).forEach((row) => { row[2] = false; });
  nextSurvey.sheets.Questions.values.push(['NEXT-1', 'Новый вопрос 1', true], ['NEXT-2', 'Новый вопрос 2', true]);
  nextSurvey.sheets.Answers.values.push(
    ['NEXT-1', 'Да', 'Нет', '', '', '', 'neutral', 'neutral', '', ''],
    ['NEXT-2', 'A', 'B', 'C', 'D', 'D', '', '', '', ''],
  );
  const oldResultDate = new Date('2026-01-01T00:00:00Z');
  nextSurvey.sheets.Results.values.push([1, 511, 'A', oldResultDate]);
  assert.deepEqual(JSON.parse(JSON.stringify(nextSurvey.context.getQuestions().map((q) => q.id))), ['NEXT-1', 'NEXT-2']);
  const nextComplete = nextSurvey.context.finish({
    id: 1, code: 'TOKEN-1',
    answers: JSON.stringify([{ questionId: 'NEXT-1', answer: 'A' }, { questionId: 'NEXT-2', answer: 'D' }]),
    results: JSON.stringify({ percentCorrect: 100, selfScore: null, portraitScore: null,
      adoptionScore: null, interestScore: null, safetyScore: null, portraitLabel: '' }),
  });
  assert.equal(nextComplete.ok, true);
  assert.equal(nextSurvey.sheets.Results.values.length, 4, 'старые Results остаются, новые ID дописываются');
  assert.deepEqual(nextSurvey.sheets.Results.values[1], [1, 511, 'A', oldResultDate], 'старая строка результата не меняется');

  const emptySurvey = createBackendContext();
  emptySurvey.sheets.Questions.values.slice(1).forEach((row) => { row[2] = false; });
  assert.equal(emptySurvey.context.getSurvey({ id: 1, code: 'TOKEN-1' }).error, 'no_active_questions');

  const invalidSave = context.saveAnswer({ id: 1, code: 'WRONG', questionId: ids[0], answer: 'A' });
  assert.equal(invalidSave.ok, false);
  assert.equal(sheets.Results.values.length, 1, 'ответ с неверным токеном не записывается');

  const firstSave = context.saveAnswer({ id: 1, code: 'TOKEN-1', questionId: ids[0], answer: 'A' });
  assert.equal(firstSave.ok, true);
  assert.equal(employeeUsage(sheets), 'Частично');
  assert.equal(context.validateCode('TOKEN-1').valid, true, 'частичный токен разрешён для продолжения');

  const incomplete = context.finish({ id: 1, code: 'TOKEN-1', results: JSON.stringify({}) });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'incomplete');
  assert.equal(employeeUsage(sheets), 'Частично');

  const synchronized = context.saveAnswers({
    id: 1,
    code: 'TOKEN-1',
    answers: JSON.stringify(ids.map((questionId) => ({ questionId, answer: 'A' }))),
  });
  assert.equal(synchronized.ok, true);
  assert.equal(synchronized.saved, 32);
  assert.equal(synchronized.appended, 31, 'batch добавляет только отсутствующие ответы');
  assert.equal(sheets.Results.values.length, 33);

  const repeated = context.saveAnswers({
    id: 1,
    code: 'TOKEN-1',
    answers: JSON.stringify(ids.map((questionId) => ({ questionId, answer: questionId === ids[0] ? 'B' : 'A' }))),
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.appended, 0, 'повтор batch не создаёт дубли');
  assert.equal(repeated.updated, 1, 'изменённый ответ обновляется на месте');
  assert.equal(sheets.Results.values.length, 33);
  assert.equal(sheets.Results.values[1][2], 'B');
  const complete = context.finish({
    id: 1,
    code: 'TOKEN-1',
    results: JSON.stringify({
      percentCorrect: 80, selfScore: 66, portraitScore: 72,
      adoptionScore: 75, interestScore: 80, safetyScore: 50,
      portraitLabel: 'Энтузиаст',
    }),
  });
  assert.equal(complete.ok, true);
  assert.equal(employeeUsage(sheets), 'Использован');
  assert.deepEqual(sheets.Employees.values[1].slice(9, 14), [72, 75, 80, 50, 'Энтузиаст']);
  assert.equal(context.validateCode('TOKEN-1').reason, 'used');
  assert.equal(context.saveAnswer({ id: 1, code: 'TOKEN-1', questionId: ids[0], answer: 'A' }).ok, false);
  assert.equal(context.saveAnswers({ id: 1, code: 'TOKEN-1', answers: '[]' }).ok, false);
  assert.equal(context.getSurvey({ id: 1, code: 'TOKEN-1' }).error, 'unauthorized');
  assert.equal(context.getQuestionsForEmployee({ id: 1, code: 'TOKEN-1' }).error, 'unauthorized');

  const atomic = createBackendContext();
  const atomicAnswers = atomic.ids.map((questionId) => ({ questionId, answer: 'A' }));
  const atomicResults = {
    percentCorrect: 80, selfScore: 66, portraitScore: 72,
    adoptionScore: 75, interestScore: 80, safetyScore: 50,
    portraitLabel: 'Энтузиаст',
  };
  const atomicComplete = atomic.context.finish({
    id: 1, code: 'TOKEN-1', answers: JSON.stringify(atomicAnswers), results: JSON.stringify(atomicResults),
  });
  assert.equal(atomicComplete.ok, true, 'finish сам синхронизирует все локальные ответы');
  assert.equal(atomic.sheets.Results.values.length, 33);
  assert.equal(employeeUsage(atomic.sheets), 'Использован');
  assert.deepEqual(atomic.sheets.Employees.values[1].slice(9, 14), [72, 75, 80, 50, 'Энтузиаст']);
  const lastEmployeeWrite = atomic.sheets.Employees.writes.at(-1);
  assert.equal(lastEmployeeWrite.values[0][0], 'Использован', 'статус записывается последним после итогов');
  assert.equal(atomic.sheets.Employees.writes.at(-2).values[0].length, 8, 'все итоговые поля пишутся одним batch');
  const atomicRetry = atomic.context.finish({
    id: 1, code: 'TOKEN-1', answers: JSON.stringify(atomicAnswers), results: JSON.stringify(atomicResults),
  });
  assert.equal(atomicRetry.ok, true, 'повтор после потерянного ответа сервера идемпотентен');
  assert.equal(atomic.sheets.Results.values.length, 33, 'повтор finish не создаёт дубли ответов');

  const cleared = createBackendContext();
  cleared.sheets.Employees.values[1].splice(7, 7, 91, 92, 93, 94, 95, 96, 'Старый портрет');
  const clearedComplete = cleared.context.finish({
    id: 1, code: 'TOKEN-1',
    answers: JSON.stringify(cleared.ids.map((questionId) => ({ questionId, answer: 'A' }))),
    results: JSON.stringify({
      percentCorrect: 0, selfScore: null, portraitScore: null,
      adoptionScore: null, interestScore: null, safetyScore: null, portraitLabel: '',
    }),
  });
  assert.equal(clearedComplete.ok, true);
  assert.deepEqual(cleared.sheets.Employees.values[1].slice(7, 14), [0, '', '', '', '', '', ''], 'новый опрос очищает неприменимые итоги старого');
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  toggle(name, force) {
    if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.children = [];
    this.style = {
      values: {},
      setProperty: (name, value) => { this.style.values[name] = value; },
    };
    this._innerHTML = '';
    this.textContent = '';
    this.className = '';
    this.disabled = false;
  }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  focus() {}
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
}

async function flush() { await new Promise((resolve) => setImmediate(resolve)); }

async function testFrontendSaveOrderingAndLayout() {
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey', 'knowledge-notice', 'knowledge-notice-ok'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const stage = new FakeElement();
  const screens = [elements['screen-survey']];
  const storage = new Map();
  const pendingSaves = [];
  const events = [];
  let protocolText = '';

  const windowObject = {
    CONFIG: {
      progressKey: 'test-progress',
      blocks: [{ id: 'self', timed: false }, { id: 'security', timed: false }],
      selfScore: { 'level-0': 0 },
      portrait: {
        dimensions: {
          adoption: { resultKey: 'adoptionScore', minAnswers: 1, weight: 0.5 },
          interest: { resultKey: 'interestScore', minAnswers: 1, weight: 0.3 },
          safety: { resultKey: 'safetyScore', minAnswers: 1, weight: 0.2 },
        },
        scores: {
          adoption: { A: { adoption: 20 }, B: { adoption: 90 } },
          interest: { A: { interest: 80 }, B: { interest: 90 } },
          safety: { A: { safety: 100 }, B: { safety: 80 } },
        },
        thresholds: [
          { max: 40, label: 'Оппонент' },
          { max: 69, label: 'Конформист' },
          { max: 100, label: 'Энтузиаст' },
        ],
      },
    },
    API: {
      saveAnswer(payload) {
        events.push(`save:${payload.questionId}`);
        return new Promise((resolve) => pendingSaves.push(() => { events.push(`saved:${payload.questionId}`); resolve({ ok: true }); }));
      },
      saveAnswers() { throw new Error('отдельный saveAnswers перед finish больше не нужен'); },
      finish(payload) { events.push(`finish:${payload.answers.length}`); return Promise.resolve({ ok: true }); },
      validateCode() { throw new Error('подтверждение не нужно при успешном finish'); },
    },
    App: { showThanks(text) { protocolText = text; events.push('thanks'); } },
  };
  windowObject.window = windowObject;

  const context = vm.createContext({
    window: windowObject,
    API: windowObject.API,
    App: windowObject.App,
    document: {
      getElementById: (id) => elements[id],
      querySelector: (selector) => selector === '.survey-stage' ? stage : null,
      querySelectorAll: (selector) => selector === '.screen' ? screens : [],
      createElement: () => new FakeElement(),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    console,
    Date,
    Promise,
    setInterval,
    clearInterval,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'survey.js'), 'utf8'), context);

  const profile = windowObject.Survey.calculateProfile(
    [{ id: 'adoption' }, { id: 'interest' }, { id: 'safety' }],
    { adoption: { value: 'A' }, interest: { value: 'A' }, safety: { value: 'A' } },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), {
    adoptionScore: 20,
    interestScore: 80,
    safetyScore: 100,
    portraitScore: 54,
    portraitLabel: 'Конформист',
  });

  const insufficient = windowObject.Survey.calculateProfile(
    [{ id: 'adoption' }, { id: 'interest' }, { id: 'safety' }],
    { adoption: { value: null, own: 'Свой ответ' }, interest: { value: 'A' }, safety: { value: 'A' } },
  );
  assert.equal(insufficient.portraitScore, null);
  assert.equal(insufficient.portraitLabel, '');

  const questions = [
    { id: '511', block: 'self', type: 'self', text: 'Вопрос 1', options: [{ key: 'A', text: 'Ответ 1', tag: 'level-0' }] },
    { id: 'NEW-SURVEY-Q', block: 'profile', type: 'profile', text: 'Новый вопрос из таблицы', options: [{ key: 'B', text: 'Новый ответ из таблицы', tag: 'neutral' }] },
  ];
  windowObject.Survey.start({ id: 1, code: 'TOKEN', fio: 'Тест' }, questions);
  assert.match(stage.className, /side-left mascot-high/);
  assert.equal(elements['q-mascot'].style.values['--mascot-tilt'], '-5deg');
  assert.equal(elements['q-mascot'].classList.contains('mascot-loading'), true, 'маскот скрыт до загрузки текущего файла');
  elements['q-mascot'].naturalWidth = 800;
  elements['q-mascot'].naturalHeight = 767;
  elements['q-mascot'].onload();
  assert.equal(elements['q-mascot'].classList.contains('mascot-loading'), false, 'маскот появляется после загрузки');

  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Новый вопрос из таблицы', 'переход не должен ждать медленный saveAnswer');
  assert.match(stage.className, /side-right mascot-low/);
  const savedProgress = windowObject.Survey.getSaved({ code: 'TOKEN' }, questions);
  assert.equal(savedProgress.index, 1, 'прогресс должен сохранять текущий вопрос независимо от кеша вопросов');
  assert.equal(savedProgress.answers['511'].value, 'A', 'прогресс должен сохранять уже выбранные ответы');
  assert.equal(windowObject.Survey.getSaved({ code: 'TOKEN' }, [{ id: 'NEW' }]), null, 'старый прогресс не переносится на новый набор вопросов');
  await flush();
  assert.deepEqual(events, ['save:511']);

  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-hint'].textContent, 'Завершаем опрос…');
  await flush();
  await flush();
  assert.deepEqual(events, ['save:511', 'finish:2', 'thanks'], 'атомарный finish не ждёт длинную очередь одиночных записей');
  assert.match(protocolText, /2\. Новый вопрос из таблицы\nОтвет: Новый ответ из таблицы/, 'новые вопросы и ответы из текущего набора попадают в протокол');
  assert.equal(pendingSaves.length, 1, 'в полёте остаётся не более одного фонового запроса');
  pendingSaves.shift()();
  await flush();
  assert.deepEqual(events, ['save:511', 'finish:2', 'thanks', 'saved:511']);
  assert.equal(events.includes('save:NEW-SURVEY-Q'), false, 'после начала финализации новые одиночные записи не запускаются');

  const resumeUser = { id: 2, code: 'TOKEN-RESUME', fio: 'Повторный вход' };
  storage.set('test-progress:TOKEN-RESUME', JSON.stringify({
    user: resumeUser, questions, index: 1, frontier: 1, done: false,
    answers: { '511': { value: 'A' }, 'NEW-SURVEY-Q': { value: 'B' } },
  }));
  const beforeResume = events.length;
  windowObject.Survey.resume(resumeUser, questions);
  await flush();
  await flush();
  assert.deepEqual(events.slice(beforeResume), ['finish:2', 'thanks'], 'полный локальный прогресс финализируется без повторного ответа 411');
}

async function testFrontendBatchRecoveryAfterSaveFailure() {
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey', 'knowledge-notice', 'knowledge-notice-ok'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const stage = new FakeElement();
  const storage = new Map();
  const events = [];
  const recoveryConsole = Object.assign({}, console, { warn() {} });
  const windowObject = {
    CONFIG: {
      progressKey: 'recovery-progress',
      blocks: [{ id: 'self', timed: false }, { id: 'security', timed: false }],
      selfScore: { 'level-0': 0 },
      portrait: { dimensions: {}, scores: {}, thresholds: [] },
    },
    API: {
      saveAnswer(payload) {
        events.push(`save:${payload.questionId}`);
        return Promise.resolve({ ok: false });
      },
      saveAnswers() { throw new Error('отдельный saveAnswers перед finish больше не нужен'); },
      finish(payload) { events.push(`finish:${payload.answers.length}`); return Promise.resolve({ ok: false }); },
      validateCode() { events.push('validate'); return Promise.resolve({ valid: false, reason: 'used' }); },
    },
    App: { showThanks() { events.push('thanks'); } },
  };
  windowObject.window = windowObject;

  const context = vm.createContext({
    window: windowObject,
    API: windowObject.API,
    App: windowObject.App,
    document: {
      getElementById: (id) => elements[id],
      querySelector: (selector) => selector === '.survey-stage' ? stage : null,
      querySelectorAll: (selector) => selector === '.screen' ? [elements['screen-survey']] : [],
      createElement: () => new FakeElement(),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    console: recoveryConsole,
    Date,
    Promise,
    setInterval,
    clearInterval,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'survey.js'), 'utf8'), context);

  const questions = [
    { id: '511', block: 'self', type: 'self', text: 'Вопрос 1', options: [{ key: 'A', text: 'Ответ 1', tag: 'level-0' }] },
    { id: '411', block: 'security', type: 'profile', text: 'Вопрос 2', options: [{ key: 'B', text: 'Ответ 2' }] },
  ];
  windowObject.Survey.start({ id: 1, code: 'RECOVERY', fio: 'Тест' }, questions);
  elements['q-body'].children[0].onclick();
  await flush();
  elements['q-body'].children[0].onclick();
  await flush();
  await flush();
  await flush();

  assert.deepEqual(events, ['save:511', 'finish:2', 'validate', 'thanks']);
  assert.equal(events.includes('save:411'), false, 'после первой ошибки остальные одиночные запросы пропускаются');
}

function testKnowledgeReviewNavigation() {
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey', 'knowledge-notice', 'knowledge-notice-ok'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const stage = new FakeElement();
  const storage = new Map();
  let timerStarts = 0;

  const windowObject = {
    CONFIG: {
      progressKey: 'knowledge-review-progress',
      blocks: [
        { id: 'attitude', timed: false, scored: false },
        { id: 'knowledge', timed: true, timerSeconds: 20, scored: true },
      ],
      selfScore: {},
      portrait: { dimensions: {}, scores: {}, thresholds: [] },
    },
    API: {
      saveAnswer: () => Promise.resolve({ ok: true }),
      saveAnswers: () => Promise.resolve({ ok: true }),
      finish: () => Promise.resolve({ ok: true }),
    },
    App: { showThanks() {} },
  };
  windowObject.window = windowObject;

  const context = vm.createContext({
    window: windowObject,
    API: windowObject.API,
    App: windowObject.App,
    document: {
      getElementById: (id) => elements[id],
      querySelector: (selector) => selector === '.survey-stage' ? stage : null,
      querySelectorAll: (selector) => selector === '.screen' ? [elements['screen-survey']] : [],
      createElement: () => new FakeElement(),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    console,
    Date,
    Promise,
    setInterval: () => { timerStarts += 1; return timerStarts; },
    clearInterval: () => {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'survey.js'), 'utf8'), context);

  const questions = [
    { id: '101', block: 'attitude', type: 'profile', text: 'Отношение 101', options: [{ key: 'A', text: 'Ответ A' }] },
    { id: '301', block: 'knowledge', type: 'knowledge', text: 'Знания 301', correct: 'D', options: [{ key: 'D', text: 'Ответ D' }] },
    { id: '302', block: 'knowledge', type: 'knowledge', text: 'Знания 302', correct: 'C', options: [{ key: 'C', text: 'Ответ C' }] },
  ];
  windowObject.Survey.start({ id: 1, code: 'KNOWLEDGE', fio: 'Тест', timerEnabled: true }, questions);
  assert.equal(timerStarts, 0, 'в профильном блоке таймер не запускается');

  elements['q-body'].children[0].onclick();
  assert.equal(elements['knowledge-notice'].classList.contains('hidden'), false, 'перед первым вопросом знаний показывается предупреждение');
  assert.equal(timerStarts, 0, 'таймер не запускается до подтверждения предупреждения');
  windowObject.Survey.confirmKnowledgeIntro();
  assert.equal(elements['q-text'].textContent, 'Знания 301');
  assert.equal(elements['knowledge-notice'].classList.contains('hidden'), true);
  assert.equal(timerStarts, 1, 'на текущем вопросе знаний запускается таймер');

  windowObject.Survey.back();
  assert.equal(elements['q-text'].textContent, 'Отношение 101');
  assert.equal(elements['q-body'].children.length, 1, 'в других блоках специальная кнопка возврата не показывается');
  assert.equal(elements['q-body'].children[0].disabled, false, 'ответ профильного блока по-прежнему можно изменить');
  elements['q-body'].children[0].onclick();
  assert.equal(timerStarts, 2);

  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Знания 302');
  assert.equal(timerStarts, 3, 'на следующем текущем вопросе запускается новый таймер');

  windowObject.Survey.back();
  assert.equal(elements['q-text'].textContent, 'Знания 301');
  assert.equal(timerStarts, 3, 'при возврате на отвеченный вопрос таймер не перезапускается');
  assert.equal(elements['q-timer'].classList.contains('hidden'), true, 'таймер при просмотре скрыт');
  assert.equal(elements['q-body'].children[0].disabled, true, 'сохранённый ответ нельзя изменить');
  const returnButton = elements['q-body'].children[1];
  assert.equal(returnButton.textContent, 'Вернуться к текущему вопросу');

  returnButton.onclick();
  assert.equal(elements['q-text'].textContent, 'Знания 302');
  assert.equal(timerStarts, 4, 'после возврата на текущий вопрос таймер запускается заново');
  assert.equal(elements['q-timer'].classList.contains('hidden'), false);
  assert.equal(elements['q-body'].children.length, 1, 'на текущем вопросе кнопка возврата не показывается');

  timerStarts = 0;
  windowObject.Survey.start({ id: 2, code: 'NO-TIMER', fio: 'Без таймера', timerEnabled: false }, questions);
  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Знания 301', 'без таймера переход к блоку знаний происходит сразу');
  assert.equal(elements['knowledge-notice'].classList.contains('hidden'), true, 'предупреждение об ограничении времени не показывается');
  assert.equal(elements['q-timer'].classList.contains('hidden'), true, 'индикатор таймера скрыт');
  assert.equal(timerStarts, 0, 'интервальный таймер не запускается');
  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Знания 302');
  assert.equal(timerStarts, 0, 'таймер остаётся выключенным на следующем вопросе знаний');

  const manyQuestions = Array.from({ length: 33 }, (_, i) => ({
    id: `M${i + 1}`, block: 'attitude', type: 'profile', text: `Вопрос ${i + 1}`,
    options: [{ key: 'A', text: 'Ответ A' }],
  }));
  windowObject.Survey.start({ id: 3, code: 'MANY', fio: 'Много вопросов', timerEnabled: false }, manyQuestions);
  for (let i = 0; i < 32; i += 1) elements['q-body'].children[0].onclick();
  assert.equal(elements['q-mascot'].src, 'assets/mascot/1.png', 'после 32 вопросов маскоты циклически повторяются');
}

function testRestartButtonRemoved() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /resume-restart|Начать заново/);
  assert.doesNotMatch(app, /resume-restart|clearSaved/);
}

function testProductionConfig() {
  const config = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'js', 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  assert.match(config, /DEMO_MODE:\s*false/);
  assert.match(config, /API_URL:\s*'https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec'/);
  assert.match(api, /action:\s*'getSurvey',\s*id:\s*user\.id,\s*code:\s*user\.code/);
  assert.match(api, /res\.ok\s*!==\s*true/);
  assert.doesNotMatch(api, /readCache|writeCache|questionsCache/);
  assert.match(app, /API\.getSurvey\(user\)/);

  const sandbox = { window: {} };
  vm.runInNewContext(config, sandbox);
  const profile = sandbox.window.CONFIG.portrait;
  const profileOptions = JSON.parse(fs.readFileSync(
    path.join(root, 'tests', 'fixtures', 'profile-options.json'),
    'utf8',
  ));
  const dimensionQuestionIds = { adoption: new Set(), interest: new Set(), safety: new Set() };

  Object.entries(profile.scores).forEach(([questionId, byAnswer]) => {
    const optionKeys = new Set(profileOptions[questionId] || []);
    assert.ok(optionKeys.size, `веса ссылаются на известный вопрос ${questionId}`);
    Object.entries(byAnswer).forEach(([answer, scores]) => {
      assert.ok(optionKeys.has(answer), `вес ${questionId}/${answer} ссылается на существующий вариант`);
      Object.entries(scores).forEach(([dimension, score]) => {
        assert.ok(dimensionQuestionIds[dimension], `известная характеристика ${dimension}`);
        assert.ok(Number.isFinite(score) && score >= 0 && score <= 100, `балл ${questionId}/${answer}/${dimension} в диапазоне 0..100`);
        dimensionQuestionIds[dimension].add(questionId);
      });
    });
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(dimensionQuestionIds).map(([key, ids]) => [key, ids.size])),
    { adoption: 8, interest: 8, safety: 5 },
  );
  assert.equal(
    Object.values(profile.dimensions).reduce((sum, dimension) => sum + dimension.weight, 0),
    1,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(profile.thresholds)),
    [{ max: 40, label: 'Оппонент' }, { max: 69, label: 'Конформист' }, { max: 100, label: 'Энтузиаст' }],
  );
}

function testWelcomeAndMascotLayoutGuards() {
  const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
  const survey = fs.readFileSync(path.join(root, 'js', 'survey.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(app, /li\.className = 'reveal-pending'/, 'принципы должны заранее занимать место');
  assert.match(app, /knowledge-notice-ok/);
  assert.match(app, /Survey\.preloadMascots\(survey\.questions\.length\)/);
  assert.match(app, /preload="auto"/);
  assert.match(styles, /\.reveal-pending\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(styles, /\.modal-overlay\s*\{/);
  assert.match(styles, /\.mascot\.mascot-loading\s*\{[^}]*opacity:\s*0/s);
  assert.match(styles, /\.mascot\.mascot-wide\s*\{/);
  assert.match(survey, /mascotPreloadAhead\s*=\s*4/);
  assert.match(survey, /preloadMascotRange/);
  assert.match(survey, /naturalWidth > mascot\.naturalHeight \* 1\.35/);
  assert.match(survey, /confirmKnowledgeIntro/);
  assert.match(html, /rel="icon" href="data:,"/);
  assert.match(html, /id="knowledge-notice"/);
  assert.match(html, /Блиц-опрос/);
  assert.match(app, /timerEnabled:\s*res\.timerEnabled !== false/);
  assert.match(app, /Ошибка настройки опроса/);
  assert.match(html, /js\/api\.js\?v=20260715-dynamic-questions/);
  assert.match(html, /js\/app\.js\?v=20260715-dynamic-questions/);
  assert.doesNotMatch(html, /js\/questions\.js/, 'production HTML не должен публиковать офлайн-копию вопросов');

  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), sandbox);
  const knowledge = sandbox.window.CONFIG.blocks.find((block) => block.id === 'knowledge');
  assert.equal(knowledge.timerSeconds, 20);
  assert.equal(sandbox.window.CONFIG.principleDelayMs, 500);

  for (const file of ['start.mp4', 'end.mp4']) {
    const bytes = fs.statSync(path.join(root, 'assets', 'media', file)).size;
    assert.ok(bytes < 3 * 1024 * 1024, `${file} должен оставаться легче 3 МБ`);
  }
}

(async () => {
  testBackendLifecycle();
  await testFrontendSaveOrderingAndLayout();
  await testFrontendBatchRecoveryAfterSaveFailure();
  testKnowledgeReviewNavigation();
  testRestartButtonRemoved();
  testProductionConfig();
  testWelcomeAndMascotLayoutGuards();
  console.log('All tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
