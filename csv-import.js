(() => {
  const fileInput = document.querySelector('#csvFile');
  const openButton = document.querySelector('#importCsv');
  const urlInput = document.querySelector('#csvUrl');
  const loadButton = document.querySelector('#loadGithubCsv');
  const saveCandlesButton = document.querySelector('#downloadCandles');
  const autoReload = document.querySelector('#autoReloadCsv');
  const note = document.querySelector('#dataNote');
  if (!fileInput || !openButton || !note) return;

  const safeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    symbol: ['symbol', 'ticker', 'tradingsymbol', 'security', 'tckrsymb'],
    date: ['date', 'datetime', 'timestamp', 'time', 'traddt'],
    timeframe: ['timeframe', 'interval', 'period'],
    series: ['series', 'sctysrs'],
    open: ['open', 'o', 'opnpric'], high: ['high', 'h', 'hghpric'], low: ['low', 'l', 'lwpric'],
    close: ['close', 'c', 'ltp', 'price', 'clspric'], volume: ['volume', 'vol', 'v', 'ttltradgvol']
  };

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n') { row.push(cell.replace(/\r$/, '').trim()); if (row.some(x => x)) rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell.replace(/\r$/, '').trim()); if (row.some(x => x)) rows.push(row);
    return rows;
  }

  function message(text) {
    const toast = document.querySelector('#toast');
    toast.textContent = text; toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  function number(value) {
    const n = Number(String(value ?? '').replace(/[₹,%\s,]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  function frameName(value) {
    const n = normalize(value || 'daily');
    if (['1d', 'd', 'day', 'daily'].includes(n)) return 'Daily';
    if (['1w', 'w', 'week', 'weekly'].includes(n)) return 'Weekly';
    if (['1mo', 'mo', 'month', 'monthly'].includes(n)) return 'Monthly';
    if (['3mo', 'q', 'quarter', 'quarterly'].includes(n)) return 'Quarterly';
    if (['6mo', 'halfyearly', 'halfyear', 'semiannual'].includes(n)) return 'Half-Yearly';
    if (['1y', 'y', 'year', 'yearly', 'annual'].includes(n)) return 'Yearly';
    return value || 'Daily';
  }

  function candleType(c) {
    const range = c.high - c.low;
    if (range <= 0) return 'Invalid range';
    const bodyPct = Math.abs(c.close - c.open) / range * 100;
    if (bodyPct < 10) return 'Doji';
    if (bodyPct < 50) return c.close >= c.open ? 'Small bullish body' : 'Small bearish body';
    return c.close >= c.open ? 'Bullish exciting candle' : 'Bearish exciting candle';
  }

  function findZones(candles, side) {
    const zones = [];
    for (let start = 1; start < candles.length - 1; start++) {
      const previous = candles[start - 1];
      if (previous.bodyPct < 50) continue;
      let end = start;
      while (end < candles.length && end - start < 5 && candles[end].bodyPct < 50) end++;
      const baseCount = end - start;
      if (baseCount < 1 || baseCount > 5 || end >= candles.length) continue;
      const departure = candles[end];
      if (departure.bodyPct < 50) continue;
      const demand = departure.close > departure.open;
      if ((side === 'demand') !== demand) continue;
      const base = candles.slice(start, end);
      const bodies = base.map(c => [Math.min(c.open, c.close), Math.max(c.open, c.close)]);
      const proximal = side === 'demand' ? Math.max(...bodies.map(b => b[1])) : Math.min(...bodies.map(b => b[0]));
      const distal = side === 'demand' ? Math.min(...base.map(c => c.low)) : Math.max(...base.map(c => c.high));
      const low = Math.min(proximal, distal), high = Math.max(proximal, distal);
      const revisits = candles.slice(end + 1).filter(c => c.low <= high && c.high >= low).length;
      const current = candles[candles.length - 1].close;
      const edgeDistance = current > high ? (current - high) / current * 100 : current < low ? (low - current) / current * 100 : 0;
      let state = current >= low && current <= high ? 'In zone' : current > high ? 'Above zone' : 'Below zone';
      if (state !== 'In zone' && edgeDistance <= 2) state = 'Near zone';
      zones.push({ low, high, startDate: base[0].date, departureDate: departure.date, baseCount, revisits, freshness: revisits === 0 ? 'Fresh' : revisits === 1 ? 'Tested once' : 'Tested 2+ times', state });
      start = end;
    }
    return zones.slice(-1)[0] || null;
  }

  function analyze(candles) {
    candles.sort((a, b) => a.date.localeCompare(b.date));
    candles.forEach(c => { c.bodyPct = (Math.abs(c.close - c.open) / (c.high - c.low)) * 100; c.type = candleType(c); });
    const last = candles.at(-1), previous = candles.at(-2);
    return {
      candles, latest: last, change: previous ? (last.close - previous.close) / previous.close * 100 : null,
      candleType: last.type, bodyPercent: last.bodyPct,
      demand: findZones(candles, 'demand'), supply: findZones(candles, 'supply')
    };
  }

  function deriveCandles(dailyCandles, timeframe) {
    const periods = new Map();
    for (const candle of dailyCandles) {
      const day = new Date(`${candle.date.slice(0, 10)}T00:00:00Z`);
      if (!Number.isFinite(day.getTime())) continue;
      const year = day.getUTCFullYear(), month = day.getUTCMonth(), date = day.getUTCDate();
      let key;
      if (timeframe === 'Weekly') {
        const monday = new Date(day); monday.setUTCDate(date - ((day.getUTCDay() + 6) % 7));
        key = monday.toISOString().slice(0, 10);
      } else if (timeframe === 'Monthly') key = `${year}-${String(month + 1).padStart(2, '0')}`;
      else if (timeframe === 'Quarterly') key = `${year}-Q${Math.floor(month / 3) + 1}`;
      else if (timeframe === 'Half-Yearly') key = `${year}-H${month < 6 ? 1 : 2}`;
      else key = String(year);
      const bar = periods.get(key);
      if (!bar) periods.set(key, { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, date: candle.date });
      else {
        bar.high = Math.max(bar.high, candle.high);
        bar.low = Math.min(bar.low, candle.low);
        bar.close = candle.close;
        bar.volume += candle.volume;
        bar.date = candle.date;
      }
    }
    return [...periods.values()];
  }

  function createStock(symbol) {
    return { symbol, name: symbol, sector: '—', price: 0, change: null,
      demand: Array(6).fill('No zone'), supply: Array(6).fill('No zone'), trend: Array(6).fill('No data'),
      match: 0, entry: '—', entryPrice: 0, sl: 0, target: 0, rr: '—', score: 0,
      freshnessScore: 0, strengthScore: 0, baseCount: 0, authentic: false, confirmation: 'type2',
      emaW: 'No data', emaM: 'No data', emaMatch: 'No data', candleFrames: {} };
  }

  function importPriceRows(rows, source) {
    const headers = rows[0].map(normalize);
    const find = names => headers.findIndex(h => names.includes(h));
    const symbolCol = find(aliases.symbol), priceCol = find(['price', 'ltp', 'lastprice', 'lasttradedprice']);
    const changeCol = rows[0].findIndex(h => /(?:%|percent|pct)/i.test(h) && /change|chg/i.test(h));
    if (symbolCol < 0 || priceCol < 0) return false;
    let updated = 0, skipped = 0;
    const available = new Map(stocks.map(stock => [stock.symbol.toUpperCase(), stock]));
    for (const cells of rows.slice(1)) {
      const symbol = String(cells[symbolCol] || '').trim().toUpperCase();
      const price = number(cells[priceCol]);
      if (!/^[A-Z0-9._-]{1,24}$/.test(symbol) || !Number.isFinite(price) || price <= 0) { skipped++; continue; }
      const stock = available.get(symbol);
      if (!stock) { skipped++; continue; }
      stock.price = price;
      if (changeCol >= 0) { const change = number(cells[changeCol]); stock.change = Number.isFinite(change) ? change : null; }
      else stock.change = null;
      updated++;
    }
    if (!updated) throw new Error('CSV ke symbols current screener list se match nahi hue.');
    document.querySelector('.sample-pill').textContent = '● CSV PRICES';
    document.querySelector('.market-pill').innerHTML = '<i></i>' + safeHtml(source);
    note.innerHTML = '<strong>CSV prices imported.</strong> Historical candle and zone signals are calculated only when OHLCV candle columns are included.';
    render();
    document.querySelector('#rowCount').textContent = `${updated} CSV price rows updated${skipped ? ` · ${skipped} skipped` : ''}`;
    message(`${updated} CSV price rows updated${skipped ? `; ${skipped} skipped` : ''}`);
    return true;
  }

  function importCandleRows(rows, source) {
    const headers = rows[0].map(normalize);
    const col = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(h => names.includes(h))]));
    if (['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'].some(key => col[key] < 0)) return false;
    const grouped = new Map(), seen = new Set(); let skipped = 0;
    for (const cells of rows.slice(1)) {
      if (col.series >= 0 && String(cells[col.series] || '').trim().toUpperCase() !== 'EQ') { skipped++; continue; }
      const symbol = String(cells[col.symbol] || '').trim().toUpperCase();
      const date = String(cells[col.date] || '').trim();
      const candle = { open: number(cells[col.open]), high: number(cells[col.high]), low: number(cells[col.low]), close: number(cells[col.close]), volume: number(cells[col.volume]), date };
      if (!/^[A-Z0-9._-]{1,24}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(date) || !Number.isFinite(Date.parse(date)) || !Object.values(candle).filter(v => typeof v === 'number').every(Number.isFinite) || Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 || candle.high <= candle.low || candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close) || candle.volume < 0) { skipped++; continue; }
      const timeframe = frameName(col.timeframe >= 0 ? cells[col.timeframe] : 'Daily');
      const key = `${symbol}|${timeframe}`;
      const candleKey = `${symbol}|${timeframe}|${date}`;
      if (seen.has(candleKey)) { skipped++; continue; }
      seen.add(candleKey);
      if (!grouped.has(key)) grouped.set(key, { symbol, timeframe, candles: [] });
      grouped.get(key).candles.push(candle);
    }
    if (!grouped.size) throw new Error('Candle CSV headers/values check karein: symbol,date,open,high,low,close,volume required hain.');
    const bySymbol = new Map();
    for (const group of grouped.values()) {
      const result = analyze(group.candles);
      if (!bySymbol.has(group.symbol)) bySymbol.set(group.symbol, {});
      bySymbol.get(group.symbol)[group.timeframe] = result;
    }
    const sourceFrames = new Map([...bySymbol].map(([symbol, frames]) => [symbol, Object.keys(frames)]));
    for (const candleFrames of bySymbol.values()) {
      const daily = candleFrames.Daily?.candles;
      if (!daily?.length) continue;
      for (const timeframe of ['Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly']) {
        if (!candleFrames[timeframe]) candleFrames[timeframe] = analyze(deriveCandles(daily, timeframe));
      }
    }
    const known = new Map(stocks.map(stock => [stock.symbol.toUpperCase(), stock]));
    const importedStocks = [];
    for (const [symbol, candleFrames] of bySymbol) {
      const stock = known.get(symbol) || createStock(symbol);
      stock.candleFrames = candleFrames;
      stock.importedTimeframes = sourceFrames.get(symbol) || Object.keys(candleFrames);
      const preferred = candleFrames.Daily || candleFrames.Weekly || candleFrames.Monthly || Object.values(candleFrames)[0];
      stock.price = preferred.latest.close;
      stock.change = preferred.change;
      stock.candleType = preferred.candleType;
      stock.bodyPercent = preferred.bodyPercent;
      stock.analysisTimeframe = candleFrames.Daily ? 'Daily' : candleFrames.Weekly ? 'Weekly' : candleFrames.Monthly ? 'Monthly' : Object.keys(candleFrames)[0];
      stock.analysis = preferred;
      stock.historicalSource = source;
      stock.demand = Array(6).fill('No data');
      stock.supply = Array(6).fill('No data');
      stock.trend = Array(6).fill('No data');
      stock.match = 0; stock.entry = 'No analysis'; stock.entryPrice = 0; stock.sl = 0; stock.target = 0; stock.rr = '—';
      stock.score = 0; stock.freshnessScore = 0; stock.strengthScore = 0; stock.baseCount = 0; stock.authentic = false;
      stock.emaW = 'No data'; stock.emaM = 'No data'; stock.emaMatch = 'No data';
      importedStocks.push(stock);
      if (!known.has(symbol)) { stocks.push(stock); known.set(symbol, stock); }
    }
    stocks.splice(0, stocks.length, ...importedStocks);
    document.querySelector('.sample-pill').textContent = '● HISTORICAL CSV · ZONES CALCULATED';
    if (saveCandlesButton) saveCandlesButton.disabled = false;
    document.querySelector('.market-pill').innerHTML = '<i></i>' + safeHtml(source);
    note.innerHTML = '<strong>Historical candles imported.</strong> Daily candles are grouped into weekly, monthly, quarterly, half-yearly and yearly candles when those timeframes are not supplied. The latest grouped candle can be incomplete. Other multi-timeframe indicators and index cards may still be sample values.';
    document.querySelector('#tabs [data-view="candles"]')?.click();
    render();
    document.querySelector('#rowCount').textContent = `${bySymbol.size} symbols · historical OHLCV candles${skipped ? ` · ${skipped} invalid rows skipped` : ''}`;
    message(`${bySymbol.size} symbols analyzed from historical candles${skipped ? `; ${skipped} invalid rows skipped` : ''}`);
    return true;
  }

  function importText(text, source) {
    const rows = parseCsv(text);
    if (rows.length === 1) {
      throw new Error('GitHub CSV abhi empty hai. Existing screener data ko safe rakha gaya hai; data aane par auto-reload khud import karega.');
    }
    if (rows.length < 2) throw new Error('CSV mein header aur kam se kam ek data row chahiye.');
    if (importCandleRows(rows, source)) return;
    if (importPriceRows(rows, source)) return;
    throw new Error('CSV mein candle ke liye symbol,date,open,high,low,close,volume ya price ke liye symbol,price columns chahiye.');
  }

  function rawGithubUrl(input) {
    const url = new URL(input);
    if (url.hostname === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 5 || parts[2] !== 'blob') throw new Error('GitHub file ka Raw link paste kijiye.');
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = '/' + [parts[0], parts[1], ...parts.slice(3)].join('/');
      url.search = ''; url.hash = '';
    }
    if (!['raw.githubusercontent.com', 'gist.githubusercontent.com'].includes(url.hostname) || url.protocol !== 'https:') {
      throw new Error('Public GitHub Raw CSV link daaliye. Private repo links supported nahi hain.');
    }
    url.searchParams.set('_refresh', Date.now());
    return url.href;
  }

  openButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])]; if (!files.length) return;
    try {
      const parsed = await Promise.all(files.map(async file => ({file, rows: parseCsv(await file.text())})));
      const headers = parsed[0].rows[0]?.map(normalize).join('|');
      if (!headers || parsed.some(item => item.rows[0]?.map(normalize).join('|') !== headers)) throw new Error('Sab selected CSV files ke headers same hone chahiye.');
      const combined = [parsed[0].rows[0], ...parsed.flatMap(item => item.rows.slice(1))];
      const csv = combined.map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
      importText(csv, `Local CSV · ${files.length} file(s) · ${new Date().toLocaleTimeString('en-IN')}`);
    }
    catch (error) { message(error.message || 'CSV import failed'); }
    finally { fileInput.value = ''; }
  });

  async function loadGithubCsv(isAuto = false) {
    const original = loadButton.textContent;
    if (loadButton.disabled) return;
    loadButton.disabled = true; loadButton.textContent = 'Loading…';
    try {
      const url = rawGithubUrl(urlInput.value.trim());
      localStorage.setItem('shivshakti-csv-url', urlInput.value.trim());
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`GitHub CSV load failed (${response.status}).`);
      importText(await response.text(), `GitHub CSV · ${new Date().toLocaleTimeString('en-IN')}`);
      if (isAuto) message('GitHub CSV auto-reload complete.');
    } catch (error) { message(error.message || 'GitHub CSV load failed'); }
    finally { loadButton.disabled = false; loadButton.textContent = original; }
  }

  try {
    const savedUrl = localStorage.getItem('shivshakti-csv-url');
    if (savedUrl && urlInput) urlInput.value = savedUrl;
    const savedAutoReload = localStorage.getItem('shivshakti-csv-auto-reload');
    const enabled = savedAutoReload === null ? true : savedAutoReload === 'true';
    if (autoReload) autoReload.checked = enabled;
  } catch { /* Browser privacy settings may disable local storage. */ }
  urlInput?.addEventListener('change', () => {
    try { localStorage.setItem('shivshakti-csv-url', urlInput.value.trim()); } catch { /* Optional preference only. */ }
  });
  autoReload?.addEventListener('change', () => {
    try { localStorage.setItem('shivshakti-csv-auto-reload', String(autoReload.checked)); } catch { /* Optional preference only. */ }
    if (autoReload.checked) loadGithubCsv();
    message(autoReload.checked ? 'Auto-reload on: public CSV har 5 minute mein dobara load hogi.' : 'Auto-reload off.');
  });
  loadButton?.addEventListener('click', () => loadGithubCsv());
  saveCandlesButton?.addEventListener('click', () => {
    const records = [['symbol', 'date', 'timeframe', 'open', 'high', 'low', 'close', 'volume']];
    for (const stock of stocks) {
      for (const timeframe of stock.importedTimeframes || []) {
        for (const candle of stock.candleFrames?.[timeframe]?.candles || []) {
          records.push([stock.symbol, candle.date, timeframe, candle.open, candle.high, candle.low, candle.close, candle.volume]);
        }
      }
    }
    if (records.length === 1) { message('Save karne ke liye imported candle rows nahi mile.'); return; }
    const csv = records.map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    link.download = 'shivshakti-historical-candles.csv';
    link.click();
    URL.revokeObjectURL(link.href);
    message(`${records.length - 1} candle rows laptop par save hui.`);
  });
  if (autoReload?.checked) loadGithubCsv();
  setInterval(() => {
    if (autoReload?.checked && !document.hidden) loadGithubCsv(true);
  }, 5 * 60 * 1000);
})();
