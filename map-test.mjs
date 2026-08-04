import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const FILE_URL = 'file:///D:/AI%20Codeing/learn%20from%20zero/index.html';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))
]);
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).json();

const watchdog = setTimeout(() => {
  console.log('WATCHDOG_EXIT');
  process.exit(2);
}, 80000);

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + process.env.TEMP + '\\codex-map-test-' + Date.now(),
  '--window-size=1440,1400',
  FILE_URL
], { stdio: 'ignore' });

let cdp = null;
try {
  let targets = [];
  for (let i = 0; i < 40; i++) {
    try { targets = await withTimeout(getJson('http://127.0.0.1:' + PORT + '/json'), 2500, 'getJson'); break; }
    catch { await delay(250); }
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('page target: ' + page.url);

  cdp = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  let msgCount = 0;
  cdp.onmessage = (ev) => {
    try {
      msgCount++;
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        events.push(msg);
      }
    } catch (err) {
      events.push({ method: 'WS_PARSE_ERROR', params: { text: String(err && err.message) } });
    }
  };
  cdp.onclose = () => events.push({ method: 'WS_CLOSE', params: {} });
  cdp.onerror = (err) => events.push({ method: 'WS_ERROR', params: { text: String(err && err.message) } });
  await withTimeout(new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; }), 10000, 'wsOpen');

  const send = (method, params = {}) => withTimeout(new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    cdp.send(JSON.stringify({ id: mid, method, params }));
  }), 20000, 'cdp:' + method);

  console.log('connected');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await delay(2500);

  const evalJs = async (expression) => {
    console.log('EVAL: ' + expression.slice(0, 60));
    const r = await withTimeout(send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), 8000, 'eval:' + expression.slice(0, 20));
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    const v = r.result && r.result.result ? r.result.result.value : undefined;
    console.log('EVAL_RESULT: ' + JSON.stringify(v));
    return v;
  };

  console.log('eval1p1: ' + await evalJs('1 + 1'));

  const checks = [];
  checks.push(['pins', await evalJs("document.querySelectorAll('.map-pin-g').length")]);
  checks.push(['mapListRows', await evalJs("document.querySelectorAll('.map-point-row').length")]);
  checks.push(['mapCount', await evalJs("document.getElementById('mapCount').textContent")]);

  const clickPos = await evalJs(`(() => {
    const svg = document.getElementById('tripMapSvg');
    const r = svg.getBoundingClientRect();
    return { x: r.left + r.width * 0.70, y: r.top + r.height * 0.45 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPos.x, y: clickPos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPos.x, y: clickPos.y, button: 'left', clickCount: 1 });
  await delay(300);
  checks.push(['editorVisible', await evalJs("!document.getElementById('mapEditor').hidden")]);

  await evalJs(`(() => {
    const n = document.getElementById('mapName');
    n.value = '测试地点';
    const t = document.getElementById('mapType');
    t.value = '美食';
    const no = document.getElementById('mapNote');
    no.value = '测试备注';
  })()`);
  await evalJs("document.querySelector('[data-action=save-map-point]').click()");
  await delay(400);
  checks.push(['pinsAfterAdd', await evalJs("document.querySelectorAll('.map-pin-g').length")]);
  checks.push(['mapCountAfterAdd', await evalJs("document.getElementById('mapCount').textContent")]);
  checks.push(['newRowExists', await evalJs(`(() => {
    const el = [...document.querySelectorAll('.map-row-name')].find((r) => r.textContent === '测试地点');
    return el ? el.textContent : null;
  })()`)]); 

  await evalJs("document.querySelector('[data-action=select-map-point]').click()");
  await delay(200);
  checks.push(['editPrefill', await evalJs("document.getElementById('mapName').value")]);

  await evalJs("document.querySelector('.map-pin-g').scrollIntoView({ block: 'center', inline: 'center' })");
  await delay(200);
  const dragInfo = await evalJs(`(() => {
    const g = document.querySelector('.map-pin-g');
    const svg = document.getElementById('tripMapSvg');
    const m = g.getAttribute('transform').match(/translate\\((\\d+),(\\d+)\\)/);
    const pt = svg.createSVGPoint();
    pt.x = Number(m[1]);
    pt.y = Number(m[2]);
    const p = pt.matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y, id: g.dataset.pointId };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragInfo.x, y: dragInfo.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragInfo.x + 60, y: dragInfo.y + 40, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragInfo.x + 60, y: dragInfo.y + 40, button: 'left', clickCount: 1 });
  await delay(300);
  checks.push(['draggedPos', await evalJs(`(() => {
    const g = document.querySelector('.map-pin-g[data-point-id="${dragInfo.id}"]');
    const m = g.getAttribute('transform').match(/translate\\((\\d+),(\\d+)\\)/);
    return m ? m[1] + ',' + m[2] : 'missing';
  })()`)]); 

  const newId = await evalJs(`(() => {
    const el = [...document.querySelectorAll('.map-point-row')].find((r) => r.querySelector('.map-row-name').textContent === '测试地点');
    return el ? el.dataset.pointId : null;
  })()`);
  if (newId) {
    const delPromise = send('Runtime.evaluate', {
      expression: `document.querySelector('.map-point-row[data-point-id="${newId}"] [data-action=delete-map-point]').click()`,
      returnByValue: true,
      awaitPromise: true
    });
    await delay(250);
    await send('Page.handleJavaScriptDialog', { accept: true });
    await withTimeout(delPromise, 5000, 'deleteClick');
    await delay(300);
  }
  checks.push(['pinsAfterDelete', await evalJs("document.querySelectorAll('.map-pin-g').length")]);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  checks.push(['mobileNoHScroll', await evalJs('document.documentElement.scrollWidth <= window.innerWidth')]);
  checks.push(['mobileMapWidth', await evalJs("Math.round(document.getElementById('tripMapSvg').getBoundingClientRect().width)")]);
  checks.push(['mobileEditorCols', await evalJs("getComputedStyle(document.querySelector('.map-editor-fields')).gridTemplateColumns")]);

  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'WS_PARSE_ERROR' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.text : (e.method === 'WS_PARSE_ERROR' ? e.params.text : e.params.entry.text));
  checks.push(['errors', JSON.stringify(errors)]);
  checks.push(['wsEvents', JSON.stringify(events.filter((e) => e.method === 'WS_CLOSE' || e.method === 'WS_ERROR' || e.method === 'WS_PARSE_ERROR'))]);
  checks.push(['msgCount', msgCount]);

  console.log(JSON.stringify(checks, null, 2));
} finally {
  if (cdp) { try { cdp.close(); } catch {} }
  chrome.kill();
  clearTimeout(watchdog);
}
