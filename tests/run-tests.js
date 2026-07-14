const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

class MockSheet {
  constructor(values) { this.values = values; }
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
      },
      setValues(values) {
        for (let r = 0; r < rows; r += 1) {
          while (sheet.values.length < row + r) sheet.values.push([]);
          for (let c = 0; c < cols; c += 1) {
            sheet.values[row - 1 + r][col - 1 + c] = values[r][c];
          }
        }
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
  const questions = [['ID вопроса', 'Отношение (1)', 'ID вопроса', 'Интерес (2)', 'ID вопроса', 'Навыки (3)']];
  for (let i = 0; i < 10; i += 1) {
    questions.push([101 + i, `A${i}`, 201 + i, `I${i}`, 301 + i, `K${i}`]);
  }
  questions.push([411, 'Security', '', '', 511, 'Self']);

  const answers = [['ID вопроса', 'Вариант A', 'Вариант B', 'Вариант C', 'Вариант D', 'Номер правильного ответа', 'Тег A', 'Тег B', 'Тег C', 'Тег D']];
  for (const id of ids) answers.push([Number(id), 'A', 'B', 'C', 'D', id[0] === '3' ? 'A' : '', 'neutral', 'neutral', 'neutral', 'neutral']);

  const sheets = {
    Employees: new MockSheet([
      ['ID', 'ФИО', 'Отдел', 'Должность', 'Токен', 'Использование', 'Дата и время прохождения', 'Процент правильных ответов', 'Балл самооценки', 'Средний балл на основе ответов', 'Принятие/готовность использовать ИИ', 'Интерес и инициативность', 'Безопасность и ответственность', 'Портрет'],
      [1, 'Тестовый Сотрудник', 'Отдел', 'Роль', 'TOKEN-1', 'Не использован', '', '', '', '', '', '', '', ''],
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
    valid: true, id: 1, fio: 'Тестовый Сотрудник', usage: 'Не использован',
  });
  assert.equal(employeeUsage(sheets), 'Не использован', 'вход не должен менять статус');

  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({}))), { ok: false, error: 'unauthorized' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({ id: 1, code: 'WRONG' }))), { ok: false, error: 'unauthorized' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getSurvey({ id: 2, code: 'TOKEN-1' }))), { ok: false, error: 'unauthorized' });
  const authorizedSurvey = context.getSurvey({ id: 1, code: 'TOKEN-1' });
  assert.equal(authorizedSurvey.ok, true);
  assert.equal(authorizedSurvey.questions.length, 32);
  assert.equal(context.getQuestionsForEmployee({}).error, 'unauthorized');
  assert.equal(context.getQuestionsForEmployee({ id: 1, code: 'TOKEN-1' }).questions.length, 32);

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
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const stage = new FakeElement();
  const screens = [elements['screen-survey']];
  const storage = new Map();
  const pendingSaves = [];
  const events = [];

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
      saveAnswers(payload) {
        events.push(`sync:${payload.answers.length}`);
        return Promise.resolve({ ok: true });
      },
      finish() { events.push('finish'); return Promise.resolve({ ok: true }); },
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
    { id: '411', block: 'security', type: 'profile', text: 'Вопрос 2', options: [{ key: 'B', text: 'Ответ 2', tag: 'neutral' }] },
  ];
  windowObject.Survey.start({ id: 1, code: 'TOKEN', fio: 'Тест' }, questions);
  assert.match(stage.className, /side-left mascot-high/);
  assert.equal(elements['q-mascot'].style.values['--mascot-tilt'], '-5deg');

  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Вопрос 2', 'переход не должен ждать медленный saveAnswer');
  assert.match(stage.className, /side-right mascot-low/);
  const savedProgress = windowObject.Survey.getSaved({ code: 'TOKEN' });
  assert.equal(savedProgress.index, 1, 'прогресс должен сохранять текущий вопрос независимо от кеша вопросов');
  assert.equal(savedProgress.answers['511'].value, 'A', 'прогресс должен сохранять уже выбранные ответы');
  await flush();
  assert.deepEqual(events, ['save:511']);

  elements['q-body'].children[0].onclick();
  assert.equal(events.includes('finish'), false, 'finish не должен обгонять последний saveAnswer');
  assert.equal(elements['q-hint'].textContent, 'Сохраняем ответы…');
  pendingSaves.shift()();
  await flush();
  assert.deepEqual(events, ['save:511', 'saved:511', 'save:411']);
  assert.equal(events.includes('finish'), false, 'finish ждёт всю последовательную очередь');
  pendingSaves.shift()();
  await flush();
  await flush();
  assert.deepEqual(events, ['save:511', 'saved:511', 'save:411', 'saved:411', 'sync:2', 'finish', 'thanks']);
}

async function testFrontendBatchRecoveryAfterSaveFailure() {
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey'];
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
      saveAnswers(payload) {
        events.push(`sync:${payload.answers.length}`);
        return Promise.resolve({ ok: true });
      },
      finish() { events.push('finish'); return Promise.resolve({ ok: true }); },
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
  elements['q-body'].children[0].onclick();
  await flush();
  await flush();
  await flush();

  assert.deepEqual(events, ['save:511', 'sync:2', 'finish', 'thanks']);
  assert.equal(events.includes('save:411'), false, 'после первой ошибки остальные одиночные запросы пропускаются');
}

function testKnowledgeReviewNavigation() {
  const ids = ['q-body', 'q-hint', 'q-timer', 'back-btn', 'progress', 'progress-fill', 'q-text', 'q-mascot', 'screen-survey'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const stage = new FakeElement();
  const storage = new Map();
  let timerStarts = 0;

  const windowObject = {
    CONFIG: {
      progressKey: 'knowledge-review-progress',
      blocks: [
        { id: 'attitude', timed: false, scored: false },
        { id: 'knowledge', timed: true, timerSeconds: 10, scored: true },
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
  windowObject.Survey.start({ id: 1, code: 'KNOWLEDGE', fio: 'Тест' }, questions);
  assert.equal(timerStarts, 0, 'в профильном блоке таймер не запускается');

  elements['q-body'].children[0].onclick();
  assert.equal(elements['q-text'].textContent, 'Знания 301');
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
  assert.match(styles, /\.reveal-pending\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(styles, /\.mascot\.mascot-wide\s*\{/);
  assert.match(survey, /naturalWidth > mascot\.naturalHeight \* 1\.35/);
  assert.match(html, /rel="icon" href="data:,"/);
  assert.match(html, /js\/api\.js\?v=20260714-save-recovery/);
  assert.match(html, /js\/app\.js\?v=20260714-save-recovery/);
  assert.doesNotMatch(html, /js\/questions\.js/, 'production HTML не должен публиковать офлайн-копию вопросов');
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
