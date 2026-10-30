/* Cloudflare Worker для TA Signals: автопостинг сигналов в канал, отправка из админки ботом,
   мгновенная выдача доступа. Вставляется целиком в редактор Worker (Edit code → Deploy).

   Settings → Variables and Secrets:
     BOT_TOKEN      — тип Secret: токен бота из @BotFather (бот должен быть админом канала)
     CHANNEL_ID     — @username канала или числовой id -100…
     ADMIN_IDS      — "861034642,900500058"
     APP_LINK       — "https://t.me/ta_signals_robot/trade228"
     ALLOWED_ORIGIN — "https://latyson.github.io"
     AUTO_ASSETS    — необязательно, по умолчанию "EURUSD,BTCUSD,ETHUSD"
     AUTO_EXP       — необязательно: 1, 3 или 5 (по умолчанию 5)
     PAYOUT         — необязательно, по умолчанию 0.8
     OPENROUTER_KEY — тип Secret, необязательно: ключ openrouter.ai — ИИ-кнопки заработают у всех пользователей
   Bindings → KV namespace, имя переменной STATE.
   Trigger events → Cron Trigger "* * * * *".

   Блок индикаторов ниже собран из index.html — логика сигнала та же, что в приложении. */

const Indicators = {
  ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let s = 0;
    for (let i = 0; i < period; i++) s += values[i];
    let prev = s / period; out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  },
  // RSI по Уайлдеру
  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / period, al = l / period;
    const calc = () => al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    out[period] = calc();
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = calc();
    }
    return out;
  },
  // Bollinger(period, mult) по последним period закрытиям, стандартное отклонение генеральной совокупности
  bollinger(closes, period = 20, mult = 2) {
    if (closes.length < period) return null;
    const w = closes.slice(-period);
    const mid = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
  },
  trend(closes15, flatPct = 0.05) {
    const e20 = Indicators.ema(closes15, 20).at(-1), e50 = Indicators.ema(closes15, 50).at(-1);
    if (e20 == null || e50 == null) return null;
    const diffPct = (e20 - e50) / e50 * 100;
    return { dir: Math.abs(diffPct) < flatPct ? 'flat' : diffPct > 0 ? 'up' : 'down', e20, e50, diffPct };
  },
  // расстояние от цены до ближайшего максимума/минимума за lookback минут
  levels(c1, price, lookback = 60) {
    const w = c1.slice(-lookback);
    const hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l));
    const dUp = hi - price, dDn = price - lo;
    return dUp <= dDn ? { type: 'high', level: hi, dist: dUp, hi, lo } : { type: 'low', level: lo, dist: dDn, hi, lo };
  },
  // средний абсолютный ход |close − open| по 5-минутным окнам за lookback минут
  move5(c1, lookback = 60, win = 5) {
    const w = c1.slice(-lookback), m = [];
    for (let i = 0; i + win <= w.length; i += win) m.push(Math.abs(w[i + win - 1].c - w[i].o));
    return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
  }
};

const Signal = {
  RSI_LOW: 30, RSI_HIGH: 70,
  // c1 — закрытые 1м свечи, c15 — закрытые 15м свечи (по возрастанию времени)
  compute(c1, c15) {
    if (!c1 || c1.length < 60 || !c15 || c15.length < 50) return { dir: 'none', error: 'insufficient' };
    const closes = c1.map(c => c.c), last = c1[c1.length - 1];
    const rsi = Indicators.rsi(closes, 14).at(-1);
    const bb = Indicators.bollinger(closes, 20, 2);
    const trend = Indicators.trend(c15.map(c => c.c));
    const level = Indicators.levels(c1, last.c, 60);
    const move = Indicators.move5(c1, 60, 5);
    const checks = {
      up:   { bb: last.c < bb.lower, rsi: rsi < Signal.RSI_LOW,  trend: trend.dir !== 'down' },
      down: { bb: last.c > bb.upper, rsi: rsi > Signal.RSI_HIGH, trend: trend.dir !== 'up' }
    };
    const all = o => o.bb && o.rsi && o.trend;
    const dir = all(checks.up) ? 'up' : all(checks.down) ? 'down' : 'none';
    return { dir, close: last.c, candle: last, rsi, bb, trend, level, move, checks };
  },
  // «Перевес» для админа: направление есть всегда, но это НЕ сигнал — сила показывает, насколько он выражен
  lean(r) {
    const half = (r.bb.upper - r.bb.mid) || 1e-12;
    const score = (50 - r.rsi) / 20 + (r.bb.mid - r.close) / half + ({ up: 0.5, down: -0.5, flat: 0 }[r.trend.dir]);
    const s = Math.abs(score);
    return { dir: score >= 0 ? 'up' : 'down', score, strength: s < 0.5 ? 'weak' : s < 1.2 ? 'mid' : 'strong' };
  }
};

const Resolve = {
  outcome(dir, entry, exit) {
    if (exit === entry) return 'refund';
    return (dir === 'up') === (exit > entry) ? 'win' : 'loss';
  },
  // sig: {dir, entryT (open time свечи после сигнальной), exp (мин)}; candles — 1м свечи
  fromCandles(sig, candles) {
    const e = candles.find(c => c.t === sig.entryT);
    const x = candles.find(c => c.t === sig.entryT + (sig.exp - 1) * 60000);
    if (!e || !x) return null;
    return { entry: e.o, exit: x.c, outcome: Resolve.outcome(sig.dir, e.o, x.c) };
  }
};


const ASSETS = {
  EURUSD: { name: 'EUR/USD', sym: 'EURUSDT', cls: 'forex', pip: 0.0001, dec: 5 },
  BTCUSD: { name: 'BTC/USD', sym: 'BTCUSDT', cls: 'crypto', dec: 2 },
  ETHUSD: { name: 'ETH/USD', sym: 'ETHUSDT', cls: 'crypto', dec: 2 }
};
const BINANCE = ['https://data-api.binance.vision', 'https://api.binance.com'];
const DIR = { up: 'ВЫШЕ', down: 'НИЖЕ' }, TREND = { up: 'вверх', down: 'вниз', flat: 'флэт' };
const RES = { win: 'ПЛЮС ✅', loss: 'МИНУС ❌', refund: 'ВОЗВРАТ ↩' };
const RISK = 'Инструмент теханализа, не гарантия. Риск потери средств.';
const EMPTY_DAY = { n: 0, w: 0, l: 0, f: 0 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOpen = (cls, d = new Date()) => cls === 'crypto' || (d.getUTCDay() >= 1 && d.getUTCDay() <= 5);
const hms = ms => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const dayKey = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
const fp = (a, v) => (+v).toFixed(a.dec);
const fdist = (a, v) => v == null ? '—' : a.cls === 'forex' ? (v / a.pip).toFixed(1) + ' п.' : '$' + v.toFixed(2);
const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';

async function klines(sym, interval, extra = {}) {
  const q = new URLSearchParams({ symbol: sym, interval, limit: '100', ...extra });
  let err;
  for (const base of BINANCE) {
    try {
      const r = await fetch(`${base}/api/v3/klines?${q}`);
      if (!r.ok) throw new Error('binance ' + r.status);
      const d = await r.json(), now = Date.now();
      return d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], ct: k[6] + 1 })).filter(c => c.ct <= now);
    } catch (e) { err = e; }
  }
  throw err;
}

const kvGet = async (env, k, d) => { const v = await env.STATE.get(k); return v == null ? d : JSON.parse(v); };
const kvPut = (env, k, v, opts) => env.STATE.put(k, JSON.stringify(v), opts);
const autoOn = async env => ((await env.STATE.get('auto')) ?? (env.AUTO_DEFAULT || 'on')) === 'on';

async function tgApi(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
async function sendToChannel(env, text, withButton = true) {
  const body = { chat_id: env.CHANNEL_ID, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  if (withButton && env.APP_LINK) {
    body.reply_markup = { inline_keyboard: [[{ text: '📊 Открыть приложение', url: env.APP_LINK + (env.APP_LINK.includes('?') ? '&' : '?') + 'startapp=channel' }]] };
  }
  const d = await tgApi(env, 'sendMessage', body);
  if (!d.ok) throw new Error(d.description || 'telegram error');
  return d;
}

function signalText(n, a, r, exp, deadline) {
  return [
    `СИГНАЛ #${n}`,
    `${a.name} (не OTC) · ${DIR[r.dir]} · ${exp} мин`,
    `Вход до ${hms(deadline)} МСК`,
    `Тренд 15м: ${TREND[r.trend.dir]} · До уровня: ${fdist(a, r.level.dist)} · Ход за 5 мин: ${fdist(a, r.move)}`,
    RISK
  ].join('\n');
}
const resultText = (p, res, a) => `#${p.n} — ${RES[res.outcome]}\nВход ${fp(a, res.entry)} → выход ${fp(a, res.exit)}`;
function dayText(env, s, ms = Date.now()) {
  const wr = s.w + s.l ? s.w / (s.w + s.l) : null, be = 1 / (1 + (Number(env.PAYOUT) || 0.8));
  const d = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));
  return [`ИТОГ ДНЯ ${d}`, `Сигналов: ${s.n}`, `ПЛЮС ${s.w} · МИНУС ${s.l} · ВОЗВРАТ ${s.f}`,
    `Винрейт без возвратов: ${pct(wr)}`, `Безубыточный винрейт: ${pct(be)}`, RISK].join('\n');
}
async function bumpDay(env, field, ms) {
  const k = 'day:' + dayKey(ms), s = await kvGet(env, k, { ...EMPTY_DAY });
  s[field]++;
  await kvPut(env, k, s, { expirationTtl: 40 * 86400 });
}

/* Раз в минуту: подводим итоги прошедших сигналов и ищем новые на только что закрытой свече. */
async function runCron(env) {
  if (!env.STATE || !env.BOT_TOKEN || !env.CHANNEL_ID) return;
  await sleep(2500); // даём бирже закрыть минутную свечу
  const now = Date.now();
  let pending = await kvGet(env, 'pending', []), changed = false;
  const keep = [];
  for (const p of pending) {
    const a = ASSETS[p.id], due = p.entryT + p.exp * 60000;
    if (now < due + 2000) { keep.push(p); continue; }
    try {
      const res = Resolve.fromCandles(p, await klines(a.sym, '1m', { startTime: String(p.entryT), limit: String(p.exp) }));
      if (res) {
        await sendToChannel(env, resultText(p, res, a), false);
        await bumpDay(env, { win: 'w', loss: 'l', refund: 'f' }[res.outcome], p.entryT);
        changed = true; continue;
      }
    } catch { }
    if (now - due < 3600e3) keep.push(p); else changed = true; // через час без данных — снимаем
  }
  pending = keep;
  if (await autoOn(env)) {
    const exp = [1, 3, 5].includes(+env.AUTO_EXP) ? +env.AUTO_EXP : 5;
    const ids = String(env.AUTO_ASSETS || 'EURUSD,BTCUSD,ETHUSD').split(',').map(s => s.trim()).filter(id => ASSETS[id]);
    for (const id of ids) {
      const a = ASSETS[id];
      if (!isOpen(a.cls) || pending.some(p => p.id === id)) continue; // по активу одна открытая сделка
      try {
        const [c1, c15] = await Promise.all([klines(a.sym, '1m'), klines(a.sym, '15m')]);
        const last = c1.at(-1);
        // свечу, закрытую больше 55 с назад, уже проверял прошлый запуск
        if (!last || now - (last.t + 60000) > 55000) continue;
        const r = Signal.compute(c1, c15);
        if (r.error || r.dir === 'none') continue;
        const n = (await kvGet(env, 'counter', 0)) + 1;
        await kvPut(env, 'counter', n);
        const entryT = last.t + 60000;
        await sendToChannel(env, signalText(n, a, r, exp, entryT + 60000));
        await bumpDay(env, 'n', entryT);
        pending.push({ n, id, dir: r.dir, entryT, exp });
        changed = true;
      } catch { }
    }
  }
  if (changed) await kvPut(env, 'pending', pending);
}

/* Проверка подписи initData (документация Telegram Mini Apps). */
const enc = new TextEncoder();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
async function verifyInitData(initData, token, maxAgeSec = 86400) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  if (hex(await hmac(await hmac('WebAppData', token), dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > maxAgeSec) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

async function handle(req, env) {
  const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', Vary: 'Origin' };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ ok: true, service: 'ta-signals-worker' });
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const user = await verifyInitData(b.initData, env.BOT_TOKEN);
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  const admins = String(env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  const admin = admins.includes(user.id), kv = !!env.STATE;
  const access = kv ? await kvGet(env, 'access', []) : [];
  if (b.action === 'me') return json({ ok: true, id: user.id, admin, unlocked: admin || access.includes(user.id) });
  // ИИ для всех пользователей: ключ OpenRouter хранится в секрете OPENROUTER_KEY, в браузер не попадает
  if (b.action === 'ai') {
    if (!env.OPENROUTER_KEY) return json({ ok: false, error: 'no ai key' }, 500);
    const messages = [{ role: 'system', content: String(b.sys || '').slice(0, 2000) }, { role: 'user', content: String(b.user || '').slice(0, 4000) }];
    for (const model of String(env.AI_MODELS || 'nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free').split(',')) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENROUTER_KEY },
          body: JSON.stringify({ model: model.trim(), messages })
        });
        if (!r.ok) continue;
        const d = await r.json(), text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (text) return json({ ok: true, text });
      } catch { }
    }
    return json({ ok: false, error: 'ai unavailable' }, 502);
  }
  if (!admin) return json({ ok: false, error: 'forbidden' }, 403);
  const needKv = () => json({ ok: false, error: 'KV STATE not bound' }, 500);
  try {
    switch (b.action) {
      case 'post':
        if (typeof b.text !== 'string' || !b.text.trim()) return json({ ok: false, error: 'empty text' }, 400);
        await sendToChannel(env, b.text);
        return json({ ok: true });
      case 'status':
        if (!kv) return json({ ok: true, kv: false, channel: env.CHANNEL_ID || null });
        return json({
          ok: true, kv: true, channel: env.CHANNEL_ID || null, auto: await autoOn(env), access,
          today: await kvGet(env, 'day:' + dayKey(), { ...EMPTY_DAY }), pending: (await kvGet(env, 'pending', [])).length,
          assets: env.AUTO_ASSETS || 'EURUSD,BTCUSD,ETHUSD', exp: [1, 3, 5].includes(+env.AUTO_EXP) ? +env.AUTO_EXP : 5
        });
      case 'setAuto':
        if (!kv) return needKv();
        await env.STATE.put('auto', b.on ? 'on' : 'off');
        return json({ ok: true, auto: !!b.on });
      case 'grant': case 'revoke': {
        if (!kv) return needKv();
        const id = Number(b.id);
        if (!Number.isSafeInteger(id) || id <= 0) return json({ ok: false, error: 'bad id' }, 400);
        const set = new Set(access);
        if (b.action === 'grant') set.add(id); else set.delete(id);
        const list = [...set];
        await kvPut(env, 'access', list);
        return json({ ok: true, access: list });
      }
      case 'postDay':
        if (!kv) return needKv();
        await sendToChannel(env, dayText(env, await kvGet(env, 'day:' + dayKey(), { ...EMPTY_DAY })));
        return json({ ok: true });
    }
  } catch (e) { return json({ ok: false, error: e.message }, 502); }
  return json({ ok: false, error: 'unknown action' }, 400);
}

export default {
  fetch: handle,
  scheduled: (event, env, ctx) => ctx.waitUntil(runCron(env))
};
