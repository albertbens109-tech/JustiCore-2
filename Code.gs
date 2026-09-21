/**
 * Justicore backend: Google Apps Script bound to a Google Sheet.
 *
 * What this file does
 *   1. setup()      Creates the Cases and Operators tabs and generates the secret keys. Run once.
 *   2. doPost()     Receives USSD traffic (via the relay) and returns the next USSD screen.
 *                   Also receives case updates from the dashboard.
 *   3. doGet()      Returns operators and cases as JSON to the dashboard.
 *
 * Keys live in Project Settings > Script properties:
 *   RELAY_SECRET   shared with the Cloudflare relay so only the relay can post USSD traffic
 *   API_KEY        the access key case officers type into the dashboard
 *   SEQ            last case number issued
 *
 * After any change to this file: Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.
 * This keeps the same web app URL.
 */

const CASE_HEADERS = [
  'ref', 'createdAt', 'channel', 'reportType', 'urgent', 'category', 'operatorId', 'operatorName', 'county',
  'status', 'partner', 'officer', 'contactAt', 'referredAt', 'resolvedAt', 'callbackConsent', 'phone',
  'notes', 'sessionId', 'networkCode', 'updatedAt'
];
const OPERATOR_HEADERS = ['id', 'name', 'shortName', 'type', 'county', 'workforce'];

// Sample operators. Replace these rows in the Operators tab with the real estates and factories.
// shortName is what the worker sees on the USSD screen: keep it to 14 characters or fewer.
// The USSD menu shows the first six operators; the next number lets the worker type a name.
// Put the six operators with the most workers first.
const SAMPLE_OPERATORS = [
  ['kap', 'Kaptarit Hills Estates Ltd', 'Kaptarit Hills', 'Multinational estate', 'Kericho', 6200],
  ['sir', 'Sirwet Valley Tea Company', 'Sirwet Valley', 'Multinational estate', 'Kericho', 4800],
  ['les', 'Lessos Crest Plantations', 'Lessos Crest', 'Multinational estate', 'Nandi', 3100],
  ['tug', 'Tugenon Ridge Estates', 'Tugenon Ridge', 'Multinational estate', 'Bomet', 2700],
  ['ker12', 'Smallholder Factory KER-12', 'Factory KER-12', 'Smallholder factory', 'Kericho', 1400],
  ['bmt05', 'Smallholder Factory BMT-05', 'Factory BMT-05', 'Smallholder factory', 'Bomet', 1150],
  ['nym07', 'Smallholder Factory NYM-07', 'Factory NYM-07', 'Smallholder factory', 'Nyamira', 980],
  ['ksi03', 'Smallholder Factory KSI-03', 'Factory KSI-03', 'Smallholder factory', 'Kisii', 1050],
];

const CATEGORIES = [
  { id: 'harassment', label: 'Sexual harassment or violence' },
  { id: 'conditions', label: 'Unsafe working conditions' },
  { id: 'wages', label: 'Wages or contract' },
  { id: 'other', label: 'Something else' },
];
const REPORT_TYPES = ['confidential', 'anonymous', 'third_party'];
const STATUS_FOR_WORKER = {
  new: 'Received, awaiting review',
  triaged: 'Reviewed by a case officer',
  referred: 'Referred for support',
  in_progress: 'Action under way',
  resolved: 'Resolved',
};
const ALLOWED_STATUS = Object.keys(STATUS_FOR_WORKER);

/* ------------------------------------------------------------------ */
/* One-time setup                                                      */
/* ------------------------------------------------------------------ */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let cases = ss.getSheetByName('Cases');
  if (!cases) cases = ss.insertSheet('Cases');
  if (cases.getLastRow() === 0) {
    cases.getRange(1, 1, 1, CASE_HEADERS.length).setValues([CASE_HEADERS]).setFontWeight('bold');
    cases.setFrozenRows(1);
  }
  // Plain text everywhere, so phone numbers keep their + and dates stay as written.
  cases.getRange(1, 1, cases.getMaxRows(), CASE_HEADERS.length).setNumberFormat('@');

  let ops = ss.getSheetByName('Operators');
  if (!ops) ops = ss.insertSheet('Operators');
  if (ops.getLastRow() === 0) {
    ops.getRange(1, 1, 1, OPERATOR_HEADERS.length).setValues([OPERATOR_HEADERS]).setFontWeight('bold');
    ops.getRange(2, 1, SAMPLE_OPERATORS.length, OPERATOR_HEADERS.length).setValues(SAMPLE_OPERATORS);
    ops.setFrozenRows(1);
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('RELAY_SECRET')) props.setProperty('RELAY_SECRET', randomKey_(32));
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', randomKey_(24));
  if (!props.getProperty('SEQ')) props.setProperty('SEQ', '1000');

  Logger.log('Setup complete.');
  Logger.log('RELAY_SECRET (paste into the Cloudflare relay): ' + props.getProperty('RELAY_SECRET'));
  Logger.log('API_KEY (give to case officers for the dashboard): ' + props.getProperty('API_KEY'));
}

function randomKey_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doPost(e) {
  const p = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();

  // USSD traffic from the relay (form-encoded)
  if (p.action === 'ussd') {
    if (p.secret !== props.getProperty('RELAY_SECRET')) return text_('END Service unavailable.');
    try {
      return text_(handleUssd_(p));
    } catch (err) {
      console.error(err);
      return text_('END Sorry, something went wrong. Please dial again.');
    }
  }

  // Dashboard requests (JSON sent as text/plain to avoid a CORS preflight)
  let body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ error: 'Invalid request body' }); }
  if (body.key !== props.getProperty('API_KEY')) return json_({ error: 'unauthorised' });
  if (body.action === 'update') return json_(updateCase_(body));
  if (body.action === 'create') return json_(createHotlineCase_(body));
  return json_({ error: 'Unknown action' });
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== PropertiesService.getScriptProperties().getProperty('API_KEY')) return json_({ error: 'unauthorised' });
  return json_({ ok: true, serverTime: new Date().toISOString(), operators: readOperators_(), cases: readCases_() });
}

function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ------------------------------------------------------------------ */
/* USSD menu                                                           */
/* ------------------------------------------------------------------ */
/*
 * Africa's Talking sends the whole journey in `text`, joined by *, e.g. "1*2*2*1*3".
 * The menu is therefore stateless: walk the answers from the start on every request.
 * "0" means Back and removes the previous answer.
 * Each screen must stay under about 160 characters.
 */
function handleUssd_(p) {
  const answers = [];
  String(p.text || '').split('*').forEach(function (x) {
    x = x.trim();
    if (x === '') return;
    if (x === '0') answers.pop(); else answers.push(x);
  });
  const code = p.serviceCode || 'the code';
  const ops = readOperators_().slice(0, 6);
  const OTHER = String(ops.length + 1);

  const MAIN = 'Justicore: confidential worker support\n1. Report an incident\n2. Check my case\n3. Know your rights';
  const HOW = 'How do you want to report?\n1. With my name (confidential)\n2. Anonymously\n3. For another worker\n0. Back';
  const SAFE = 'Are you safe right now?\n1. No, I need help now\n2. Yes, I can continue\n0. Back';
  const CALL = 'Can a case officer call you on this number?\n1. Yes, call me\n2. No\n0. Back';
  const WHAT = 'What happened?\n' + CATEGORIES.map(function (c, i) { return (i + 1) + '. ' + c.label; }).join('\n') + '\n0. Back';
  const WHERE = 'Where do you work?\n' + ops.map(function (o, i) { return (i + 1) + '. ' + o.shortName; }).join('\n') + '\n' + OTHER + '. Other\n0. Back';
  const RIGHTS = 'Know your rights\n1. Sexual harassment\n2. Wages and conditions\n3. Protection when you report\n0. Back';
  const bad = function (screen) { return 'CON Invalid choice.\n' + screen; };
  const inRange = function (v, n) { return /^\d+$/.test(v) && +v >= 1 && +v <= n; };

  if (answers.length === 0) return 'CON ' + MAIN;
  const top = answers[0];

  // 1. Report an incident
  if (top === '1') {
    if (answers.length === 1) return 'CON ' + HOW;
    if (!inRange(answers[1], 3)) return bad(HOW);
    const reportType = REPORT_TYPES[+answers[1] - 1];
    if (answers.length === 2) return 'CON ' + SAFE;
    if (!inRange(answers[2], 2)) return bad(SAFE);

    if (answers[2] === '1') { // needs help now
      if (answers.length === 3) return 'CON ' + CALL;
      if (!inRange(answers[3], 2)) return bad(CALL);
      const consent = answers[3] === '1';
      const ref = createCase_({ p: p, reportType: reportType, urgent: true, category: '', operator: null, operatorName: '', consent: consent });
      return 'END Flagged urgent. ' + (consent ? 'An officer will call you within 2 hours.' : 'Dial ' + code + ' and choose 2 for updates.') +
        '\nIn danger now? Call 999 or 112.\nRef: ' + ref;
    }

    if (answers.length === 3) return 'CON ' + WHAT;
    if (!inRange(answers[3], CATEGORIES.length)) return bad(WHAT);
    const category = CATEGORIES[+answers[3] - 1].id;
    if (answers.length === 4) return 'CON ' + WHERE;

    let operator = null, operatorName = '';
    if (answers[4] === OTHER) {
      if (answers.length === 5) return 'CON Type the name of the estate or factory';
      operatorName = answers.slice(5).join(' ').slice(0, 80);
    } else if (inRange(answers[4], ops.length)) {
      operator = ops[+answers[4] - 1];
      operatorName = operator.name;
    } else {
      return bad(WHERE);
    }
    const ref = createCase_({ p: p, reportType: reportType, urgent: false, category: category, operator: operator, operatorName: operatorName, consent: false });
    return 'END Thank you. Your report is received.\nRef: ' + ref + '\nKeep this number. Dial ' + code + ' and choose 2 to follow up.';
  }

  // 2. Check my case
  if (top === '2') {
    if (answers.length === 1) return 'CON Enter your case number (the digits at the end of your Ref)';
    const digits = String(answers[1]).replace(/\D/g, '');
    const c = digits ? findByDigits_(digits) : null;
    if (!c) return 'END No case found for ' + answers[1] + '. Check the number and dial again.';
    return 'END Case ' + c.ref + '\nStatus: ' + (STATUS_FOR_WORKER[c.status] || c.status) +
      (c.updatedAt ? '\nUpdated: ' + Utilities.formatDate(new Date(c.updatedAt), 'Africa/Nairobi', 'd MMM yyyy') : '');
  }

  // 3. Know your rights
  if (top === '3') {
    if (answers.length === 1) return 'CON ' + RIGHTS;
    const texts = {
      '1': 'Employers with 20+ staff must have a sexual harassment policy (Employment Act s 6). Harassment by a person in authority is a crime (Sexual Offences Act s 23).',
      '2': 'The Constitution (Art 41) guarantees fair labour practices and reasonable working conditions. Raise unpaid wages with a union or the county labour office.',
      '3': 'Dismissal for filing a complaint against an employer is unfair (Employment Act s 46). Your report is shared only as far as needed to act on it.',
    };
    return texts[answers[1]] ? 'END ' + texts[answers[1]] : bad(RIGHTS);
  }

  return bad(MAIN);
}

/* ------------------------------------------------------------------ */
/* Data access                                                         */
/* ------------------------------------------------------------------ */

function casesSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Cases'); }

function readOperators_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Operators');
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  return rows.filter(function (r) { return r[0]; }).map(function (r) {
    const o = {}; head.forEach(function (h, i) { o[h] = r[i]; });
    o.workforce = Number(o.workforce) || 0;
    return o;
  });
}

function readCases_() {
  const rows = casesSheet_().getDataRange().getValues();
  const head = rows.shift();
  return rows.filter(function (r) { return r[0]; }).map(function (r) {
    const o = {}; head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
    o.urgent = String(o.urgent) === 'yes';
    o.callbackConsent = String(o.callbackConsent) === 'yes';
    try { o.notes = o.notes ? JSON.parse(o.notes) : []; } catch (err) { o.notes = []; }
    return o;
  });
}

function findByDigits_(digits) {
  const all = readCases_();
  for (let i = all.length - 1; i >= 0; i--) {
    if (String(all[i].ref).split('-').pop() === digits) return all[i];
  }
  return null;
}

function createCase_(o) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = casesSheet_();
    const sid = o.p.sessionId || '';
    // A retried request from the same USSD session must not create a second case.
    if (sid) {
      const hit = sh.getRange(2, CASE_HEADERS.indexOf('sessionId') + 1, Math.max(1, sh.getLastRow() - 1), 1)
        .createTextFinder(sid).matchEntireCell(true).findNext();
      if (hit) return sh.getRange(hit.getRow(), 1).getValue();
    }
    const props = PropertiesService.getScriptProperties();
    const seq = Number(props.getProperty('SEQ') || '1000') + 1;
    props.setProperty('SEQ', String(seq));
    const ref = 'JC-' + Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yy') + '-' + seq;
    const now = new Date().toISOString();
    // Keep the phone number only where the worker has chosen to be reachable.
    const keepPhone = o.reportType !== 'anonymous' || o.consent;
    const row = {
      ref: ref, createdAt: now, channel: 'ussd', reportType: o.reportType, urgent: o.urgent ? 'yes' : 'no',
      category: o.category, operatorId: o.operator ? o.operator.id : '', operatorName: o.operatorName,
      county: o.operator ? o.operator.county : '', status: 'new', partner: '', officer: '',
      contactAt: '', referredAt: '', resolvedAt: '', callbackConsent: o.consent ? 'yes' : 'no',
      phone: keepPhone ? (o.p.phoneNumber || '') : '', notes: '[]', sessionId: sid,
      networkCode: o.p.networkCode || '', updatedAt: now,
    };
    sh.appendRow(CASE_HEADERS.map(function (h) { return row[h]; }));
    return ref;
  } finally {
    lock.releaseLock();
  }
}

function createHotlineCase_(b) {
  const ops = readOperators_();
  const op = ops.filter(function (o) { return o.id === b.operatorId; })[0] || null;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const seq = Number(props.getProperty('SEQ') || '1000') + 1;
    props.setProperty('SEQ', String(seq));
    const ref = 'JC-' + Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yy') + '-' + seq;
    const now = new Date().toISOString();
    const notes = b.note ? [{ by: b.officer || 'Case officer', ts: now, text: String(b.note).slice(0, 2000) }] : [];
    const row = {
      ref: ref, createdAt: now, channel: 'hotline', reportType: REPORT_TYPES.indexOf(b.reportType) >= 0 ? b.reportType : 'confidential',
      urgent: b.urgent ? 'yes' : 'no', category: b.category || 'other', operatorId: op ? op.id : '', operatorName: op ? op.name : '',
      county: op ? op.county : '', status: 'triaged', partner: '', officer: b.officer || '', contactAt: now, referredAt: '',
      resolvedAt: '', callbackConsent: 'no', phone: String(b.phone || ''), notes: JSON.stringify(notes), sessionId: '',
      networkCode: '', updatedAt: now,
    };
    casesSheet_().appendRow(CASE_HEADERS.map(function (h) { return row[h]; }));
    return { ok: true, ref: ref };
  } finally {
    lock.releaseLock();
  }
}

function updateCase_(b) {
  const sh = casesSheet_();
  const hit = sh.getRange('A:A').createTextFinder(String(b.ref || '')).matchEntireCell(true).findNext();
  if (!b.ref || !hit) return { error: 'Case not found' };
  const r = hit.getRow();
  const set = function (field, value) { sh.getRange(r, CASE_HEADERS.indexOf(field) + 1).setValue(value); };
  const now = new Date().toISOString();

  if (b.status && ALLOWED_STATUS.indexOf(b.status) >= 0) set('status', b.status);
  if (b.partner !== undefined) set('partner', b.partner || '');
  if (b.officer) set('officer', b.officer);
  ['contactAt', 'referredAt', 'resolvedAt'].forEach(function (f) { if (b[f]) set(f, b[f]); });
  if (b.note) {
    const cell = sh.getRange(r, CASE_HEADERS.indexOf('notes') + 1);
    let notes = [];
    try { notes = JSON.parse(cell.getValue() || '[]'); } catch (err) {}
    notes.push({ by: b.officer || 'Case officer', ts: now, text: String(b.note).slice(0, 2000) });
    cell.setValue(JSON.stringify(notes));
  }
  set('updatedAt', now);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Test helper: run from the editor to try the menu without a phone    */
/* ------------------------------------------------------------------ */
function testUssd() {
  ['', '1', '1*2', '1*2*2', '1*2*2*1', '1*2*2*1*3', '2', '3', '3*1'].forEach(function (t) {
    const out = t === '1*2*2*1*3'
      ? '(skipped: would create a case)'
      : handleUssd_({ text: t, serviceCode: '*384*1234#', sessionId: 'test', phoneNumber: '+254700000000' });
    Logger.log('text="' + t + '"\n' + out + '\n');
  });
}
