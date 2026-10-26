(() => {
  const fileInput = document.querySelector('#csvFile');
  const openButton = document.querySelector('#importCsv');

  const urlInput = document.querySelector('#csvUrl');
  const loadButton = document.querySelector('#loadGithubCsv');
  const saveCandlesButton = document.querySelector('#downloadCandles');
  const autoReload = document.querySelector('#autoReloadCsv');
  const note = document.querySelector('#dataNote');
  const timeframeFilter = document.querySelector('#frameFilter');
  if (timeframeFilter && ![...timeframeFilter.options].some(option => option.value === '15-minute')) {
    timeframeFilter.add(new Option('15-minute', '15-minute'));
  }
  if (!fileInput || !openButton || !note) return;

  const safeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    symbol: ['symbol', 'ticker', 'tradingsymbol', 'security', 'tckrsymb'],
    date: ['date', 'datetime', 'timestamp', 'time', 'traddt', 'tradingdate'],
    timeframe: ['timeframe', 'interval', 'period'],
    series: ['series', 'sctysrs'],
    open: ['open', 'o', 'opnpric', 'openprice'], high: ['high', 'h', 'hghpric', 'highprice'], low: ['low', 'l', 'lwpric', 'lowprice'],
    close: ['close', 'c', 'ltp', 'price', 'clspric', 'closeprice'], volume: ['volume', 'vol', 'v', 'ttltradgvol', 'totaltradedquantity']
  };

  function normalizeDate(value) {
    const text = String(value || '').trim();
    if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(text)) {
      const [day, mon, year] = text.split('-');
      const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(mon.toLowerCase());
      if (month >= 0) return `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return text;
  }

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
    if (['15m', '15min', '15minute', 'intraday'].includes(n)) return '15-minute';
    if (['75m', '75min', '75minute'].includes(n)) return '75-minute';
    if (['125m', '125min', '125minute'].includes(n)) return '125-minute';
    if (['275m', '275min', '275minute'].includes(n)) return '275-minute';
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
    if (bodyPct <= 50) return c.close >= c.open ? 'Small bullish body' : 'Small bearish body';
    return c.close >= c.open ? 'Bullish exciting candle' : 'Bearish exciting candle';
  }

  function findZones(candles, side) {
    const zones = [];
    for (let start = 1; start < candles.length - 1; start++) {
      const previous = candles[start - 1];
      if (previous.bodyPct <= 50) continue;
      let end = start;
      while (end < candles.length && candles[end].bodyPct < 50) end++;
      const baseCount = end - start;
      if (baseCount < 1 || end >= candles.length) continue;
      const departure = candles[end];
      if (departure.bodyPct <= 50) { start = end; continue; }
      const demand = departure.close > departure.open;
      if ((side === 'demand') !== demand) continue;
      if (demand ? departure.close <= previous.close : departure.close >= previous.close) continue;
      const base = candles.slice(start, end);
      const bodies = base.map(c => [Math.min(c.open, c.close), Math.max(c.open, c.close)]);
      const proximal = side === 'demand' ? Math.max(...bodies.map(b => b[1])) : Math.min(...bodies.map(b => b[0]));
      const distal = side === 'demand' ? Math.min(...base.map(c => c.low)) : Math.max(...base.map(c => c.high));
      const low = Math.min(proximal, distal), high = Math.max(proximal, distal);
      let revisits = 0, wasInside = false;
      for (let future = end + 1; future < candles.length; future++) {
        const candle = candles[future];
        const inside = candle.low <= high && candle.high >= low;
        if (inside && !wasInside) {
          revisits++;
          if (revisits >= 2) break;
        }
        wasInside = inside;
      }
      const next = candles[end + 1];
      const gap = side === 'demand' ? departure.low > base.at(-1).high : departure.high < base.at(-1).low;
      const secondExciting = Boolean(next && next.bodyPct > 50 && (side === 'demand' ? next.close > next.open : next.close < next.open));
      const strengthReason = gap ? 'gap' : secondExciting ? 'twoCandles' : 'singleNoGap';
      const strengthScore = gap || secondExciting ? 2 : 1;
      const freshnessScore = revisits === 0 ? 3 : revisits === 1 ? 1.5 : 0;
      const baseScore = baseCount <= 3 ? 2 : baseCount <= 5 ? 1 : 0;
      const pattern = side === 'demand' ? (previous.close < previous.open ? 'DBR' : 'RBR') : (previous.close > previous.open ? 'RBD' : 'DBD');
      const overlappingPrior = zones.find(zone => zone.high >= low && zone.low <= high);
      const current = candles[candles.length - 1].close;
      const edgeDistance = current > high ? (current - high) / current * 100 : current < low ? (low - current) / current * 100 : 0;
      let state = current >= low && current <= high ? 'In zone' : current > high ? 'Above zone' : 'Below zone';
      if (state !== 'In zone' && edgeDistance <= 2) state = 'Near zone';
      zones.push({ side, low, high, proximal, distal, startDate: base[0].date, departureDate: departure.date, departureIndex: end, baseCount, revisits, freshnessScore, freshness: revisits === 0 ? 'Fresh' : revisits === 1 ? 'Tested once' : 'Tested 2+ times', strengthReason, strengthScore, baseScore, score: freshnessScore + strengthScore + baseScore, pattern, authentic: !overlappingPrior, authenticityReason: overlappingPrior ? `Overlaps earlier ${side} zone from ${overlappingPrior.startDate}` : 'No overlap with earlier same-side zone found', state });
      start = end;
    }
    return zones;
  }

  function candleInZone(candle, zone, field) { return candle[field] >= zone.low && candle[field] <= zone.high; }

  function latestConfirmation(candles, zone) {
    if (!zone || candles.length < 2) return null;
    const first = candles.at(-2), second = candles.at(-1);
    if (first.close < zone.low || first.close > zone.high) return null;
    const exitsCorrectly = zone.side === 'demand' ? second.close > zone.high : second.close < zone.low;
    if (exitsCorrectly) return { type: 'type3', date: second.date };
    if (candleInZone(second, zone, 'open')) return { type: 'type2', date: second.date };
    return null;
  }

  function trendFromGyan(candles) {
    if (candles.length < 57) return { label: 'Insufficient 57 candles', slopePercent: null };
    const averageAt = end => candles.slice(end - 49, end + 1).reduce((sum, candle) => sum + candle.close, 0) / 50;
    const now = averageAt(candles.length - 1), then = averageAt(candles.length - 8);
    const slopePercent = (now - then) / candles.at(-1).close * 100;
    const label = slopePercent > 0.1 ? 'Uptrend' : slopePercent < -0.1 ? 'Downtrend' : 'Sideways';
    return { label, slopePercent };
  }

  function closestZone(zones, price) {
    return zones.filter(zone => zone.revisits === 0).sort((a, b) => {
      const distance = zone => price < zone.low ? zone.low - price : price > zone.high ? price - zone.high : 0;
      return distance(a) - distance(b);
    })[0] || null;
  }

  function curveLocation(price, demand, supply) {
    if (!demand || !supply) return { label: demand || supply ? 'Equilibrium (one fresh zone)' : 'Equilibrium (no fresh zones)', ratio: null };
    if (supply.proximal <= demand.proximal) return { label: 'Equilibrium (zone order unclear)', ratio: null };
    const ratio = (price - demand.proximal) / (supply.proximal - demand.proximal);
    if (ratio <= 1 / 3) return { label: 'Low / very low', ratio };
    if (ratio >= 2 / 3) return { label: 'High / very high', ratio };
    return { label: 'Equilibrium', ratio };
  }

  function gyanTradeData(analysis, candles, forcedSide = null) {
    const price = analysis.latest.close;
    const demand = closestZone(analysis.demandZones, price);
    const supply = closestZone(analysis.supplyZones, price);
    const trend = trendFromGyan(candles);
    const location = curveLocation(price, demand, supply);
    let side = forcedSide || (location.label.startsWith('Low') ? 'demand' : location.label.startsWith('High') ? 'supply' : trend.label === 'Uptrend' ? 'demand' : trend.label === 'Downtrend' ? 'supply' : null);
    if (!demand && !supply && !forcedSide) side = null;
    const zone = side === 'demand' ? (demand || (forcedSide === 'demand' ? analysis.demand : null)) : side === 'supply' ? (supply || (forcedSide === 'supply' ? analysis.supply : null)) : [analysis.demand, analysis.supply].filter(Boolean).sort((a,b) => b.score-a.score)[0] || null;
    const confirmation = latestConfirmation(candles, zone);
    let entryType = forcedSide && !zone ? 'No trade · no ' + forcedSide + ' zone' : 'No trade · trend/location not confirmed';
    if (zone) {
      if (!zone.authentic) entryType = 'No trade · non-authentic zone';
      else if (zone.score < 5) entryType = 'No trade · score below 5';
      else if (!side || !['Uptrend','Downtrend'].includes(trend.label)) entryType = 'Ignore · trend sideways/insufficient';
      else if ((side === 'demand' && trend.label !== 'Uptrend') || (side === 'supply' && trend.label !== 'Downtrend')) entryType = 'Ignore · trend conflicts';
      else if (zone.score === 7) entryType = 'Type 1 · Set & Forget';
      else if (zone.score >= 5 && confirmation?.type === 'type2') entryType = 'Type 2 · close/open confirmed';
      else if (zone.score >= 5 && confirmation?.type === 'type3') entryType = 'Type 3 · exit confirmed';
      else entryType = 'Wait · Type 2/3 confirmation';
    }
    const entryLine = zone?.proximal ?? 0, stopLine = zone?.distal ?? 0;
    const tradeSide = side || zone?.side;
    const risk = tradeSide === 'supply' ? stopLine - entryLine : entryLine - stopLine;
    const targetLine = risk > 0 ? entryLine + (tradeSide === 'supply' ? -2 : 2) * risk : 0;
    return { side, zone, demand, supply, location, trend, confirmation, entryType, entryLine, stopLine, targetLine, score: zone?.score ?? 0 };
  }

  function analyze(candles) {
    candles.sort((a, b) => a.date.localeCompare(b.date));
    candles.forEach(c => { c.bodyPct = (Math.abs(c.close - c.open) / (c.high - c.low)) * 100; c.type = candleType(c); });
    const last = candles.at(-1), previous = candles.at(-2);
    const zoneCandles = candles.length > 300 ? candles.slice(-300) : candles;
    const demandZones = findZones(zoneCandles, 'demand'), supplyZones = findZones(zoneCandles, 'supply');
    const result = {
      candles, latest: last, change: previous ? (last.close - previous.close) / previous.close * 100 : null,
      candleType: last.type, bodyPercent: last.bodyPct, demandZones, supplyZones,
      demand: demandZones.at(-1) || null, supply: supplyZones.at(-1) || null
    };
    result.gyanTrade = gyanTradeData(result, candles);
    result.gyanBySide = { demand: gyanTradeData(result, candles, 'demand'), supply: gyanTradeData(result, candles, 'supply') };
    return result;
  }

  function deriveIntradayCandles(sourceCandles, minutes) {
    const buckets = new Map();
    for (const candle of [...sourceCandles].sort((a, b) => a.date.localeCompare(b.date))) {
      const match = String(candle.date).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
      if (!match) continue;
      const minuteOfDay = Number(match[2]) * 60 + Number(match[3]);
      const offset = minuteOfDay - 555;
      if (offset < 0 || offset >= 375) continue;
      const bucket = Math.floor(offset / minutes);
      const key = match[1] + '|' + bucket;
      const startMinute = 555 + bucket * minutes;
      const start = match[1] + ' ' + String(Math.floor(startMinute / 60)).padStart(2, '0') + ':' + String(startMinute % 60).padStart(2, '0');
      const current = buckets.get(key);
      if (!current) buckets.set(key, { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, date: start });
      else { current.high = Math.max(current.high, candle.high); current.low = Math.min(current.low, candle.low); current.close = candle.close; current.volume += candle.volume; }
    }
    return [...buckets.values()];
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

  function createCandleImporter(headerRow) {
    const headers = headerRow.map(normalize);
    const col = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex(h => names.includes(h))]));
    if (['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'].some(key => col[key] < 0)) return null;
    const grouped = new Map(), lastDateByKey = new Map(); let skipped = 0;
    function add(cells) {
      if (col.series >= 0 && String(cells[col.series] || '').trim().toUpperCase() !== 'EQ') { skipped++; return; }
      const symbol = String(cells[col.symbol] || '').trim().toUpperCase();
      const date = normalizeDate(cells[col.date]);
      const candle = { open: number(cells[col.open]), high: number(cells[col.high]), low: number(cells[col.low]), close: number(cells[col.close]), volume: number(cells[col.volume]), date };
      if (!/^[A-Z0-9._-]{1,24}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(date) || !Number.isFinite(Date.parse(date)) || !Object.values(candle).filter(v => typeof v === 'number').every(Number.isFinite) || Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 || candle.high <= candle.low || candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close) || candle.volume < 0) { skipped++; return; }
      const timeframe = frameName(col.timeframe >= 0 ? cells[col.timeframe] : 'Daily');
      const key = `${symbol}|${timeframe}`;
      if (lastDateByKey.get(key) === date) { skipped++; return; }
      lastDateByKey.set(key, date);
      if (!grouped.has(key)) grouped.set(key, { symbol, timeframe, candles: [] });
      grouped.get(key).candles.push(candle);
    }
    function finish(source) {
    if (!grouped.size) throw new Error('Candle CSV headers/values check karein: symbol,date,open,high,low,close,volume required hain.');
    const bySymbol = new Map();
    for (const group of grouped.values()) {
      const result = analyze(group.candles);
      if (!bySymbol.has(group.symbol)) bySymbol.set(group.symbol, {});
      bySymbol.get(group.symbol)[group.timeframe] = result;
    }
    const sourceFrames = new Map([...bySymbol].map(([symbol, frames]) => [symbol, Object.keys(frames)]));
    for (const candleFrames of bySymbol.values()) {
      const fifteenMinute = candleFrames['15-minute']?.candles;
      if (fifteenMinute?.length) {
        for (const minutes of [75, 125, 275]) {
          const frame = String(minutes) + '-minute';
          if (!candleFrames[frame]) {
            const aggregated = deriveIntradayCandles(fifteenMinute, minutes);
            if (aggregated.length) candleFrames[frame] = analyze(aggregated);
          }
        }
      }
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
      const scoreFrames = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'];
      const tradeFrames = [...scoreFrames, '15-minute', '75-minute', '125-minute', '275-minute'];
      stock.gyanByTimeframe = Object.fromEntries(tradeFrames.filter(frame => candleFrames[frame]).map(frame => [frame, candleFrames[frame].gyanTrade]));
      stock.gyanByTimeframeAndSide = Object.fromEntries(tradeFrames.filter(frame => candleFrames[frame]).map(frame => [frame, candleFrames[frame].gyanBySide]));
      stock.analysisTimeframe = candleFrames.Daily ? 'Daily' : candleFrames.Weekly ? 'Weekly' : candleFrames.Monthly ? 'Monthly' : Object.keys(candleFrames)[0];
      stock.gyanTrade = stock.gyanByTimeframe[stock.analysisTimeframe] || preferred.gyanTrade;
      stock.price = preferred.latest.close;
      stock.change = preferred.change;
      stock.candleType = preferred.candleType;
      stock.bodyPercent = preferred.bodyPercent;
      stock.analysis = preferred;
      stock.historicalSource = source;
      stock.demand = scoreFrames.map(frame => candleFrames[frame]?.demand?.state || 'No zone');
      stock.supply = scoreFrames.map(frame => candleFrames[frame]?.supply?.state || 'No zone');
      stock.trend = scoreFrames.map(frame => { const label = candleFrames[frame]?.gyanTrade?.trend.label; return label === 'Uptrend' ? 'Bullish' : label === 'Downtrend' ? 'Bearish' : label === 'Sideways' ? 'Neutral' : 'No data'; });
      const active = stock.gyanTrade, zone = active?.zone;
      stock.dataDriven = true;
      stock.gyanDirection = active?.side || null;
      stock.gyanLocation = active?.location?.label || 'Unknown';
      stock.gyanTrend = active?.trend?.label || 'Insufficient data';
      stock.gyanEntryType = active?.entryType || 'No trade · no qualifying zone';
      stock.gyanScoreBreakdown = zone ? `Freshness ${zone.freshnessScore}/3 + Strength ${zone.strengthScore}/2 + Base ${zone.baseScore}/2` : 'No qualifying zone';
      stock.match = 0;
      stock.entry = stock.gyanEntryType;
      stock.entryPrice = active?.entryLine || 0; stock.sl = active?.stopLine || 0; stock.target = active?.targetLine || 0; stock.rr = zone && active?.targetLine ? '1:2' : '—';
      stock.score = zone?.score || 0; stock.freshnessScore = zone?.freshnessScore || 0; stock.strengthScore = zone?.strengthScore || 0; stock.strengthReason = zone?.strengthReason || ''; stock.baseCount = zone?.baseCount || 0; stock.authentic = zone?.authentic || false; stock.confirmation = active?.confirmation?.type || '';
      stock.emaW = 'No data'; stock.emaM = 'No data'; stock.emaMatch = 'No data';
      importedStocks.push(stock);
      if (!known.has(symbol)) { stocks.push(stock); known.set(symbol, stock); }
    }
    stocks.splice(0, stocks.length, ...importedStocks);
    document.querySelector('.sample-pill').textContent = '● HISTORICAL CSV · ZONES CALCULATED';
    if (saveCandlesButton) saveCandlesButton.disabled = false;
    document.querySelector('.market-pill').innerHTML = '<i></i>' + safeHtml(source);
    note.innerHTML = '<strong>Historical OHLCV candles imported.</strong> All imported candles remain available in Historical Candles. Zone detection scans the latest 300 candles per timeframe to keep the full 48 MB history responsive. Weekly/monthly groups can be incomplete. EMA/index cards remain unavailable. Gap, 50-SMA flat cutoff and overlap-based authenticity are screening approximations; this is not a trade recommendation.';
    document.querySelector('#tabs [data-view="candles"]')?.click();
    render();
    document.querySelector('#rowCount').textContent = `${bySymbol.size} symbols · historical OHLCV candles${skipped ? ` · ${skipped} invalid rows skipped` : ''}`;
    message(`${bySymbol.size} symbols analyzed from historical candles${skipped ? `; ${skipped} invalid rows skipped` : ''}`);
    return true;
    }
    return { add, finish };
  }

  function importCandleRows(rows, source) {
    const importer = createCandleImporter(rows[0]);
    if (!importer) return false;
    for (const cells of rows.slice(1)) importer.add(cells);
    return importer.finish(source);
  }

  async function importLargeCandleStream(response, source) {
    if (!response.body) throw new Error('Browser stream reading is unavailable for the historical file.');
    const reader = response.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value) throw new Error('Historical CSV file is empty.');
    let stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(first.value);
        try {
          while (true) { const part = await reader.read(); if (part.done) break; controller.enqueue(part.value); }
          controller.close();
        } catch (error) { controller.error(error); }
      }
    });
    const firstBytes = first.value;
    if (firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open the compressed history file.');
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const textReader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let pending = '', importer = null, importedRows = 0, rowsSinceUpdate = 0;
    const consumeLine = line => {
      if (!line.trim()) return;
      const cells = parseCsv(line)[0] || [];
      if (!importer) {
        importer = createCandleImporter(cells);
        if (!importer) throw new Error('CSV headers need symbol,date,open,high,low,close,volume columns.');
        return;
      }
      importer.add(cells); importedRows++; rowsSinceUpdate++;
    };
    while (true) {
      const part = await textReader.read();
      if (part.value) pending += decoder.decode(part.value, {stream: true});
      if (part.done) { pending += decoder.decode(); break; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); consumeLine(line);
      }
      if (rowsSinceUpdate >= 10000) {
        loadButton.textContent = 'Loading… ' + importedRows.toLocaleString('en-IN') + ' rows';
        rowsSinceUpdate = 0; await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (pending.trim()) consumeLine(pending);
    if (!importer || !importedRows) throw new Error('Historical CSV has no candle rows.');
    loadButton.textContent = 'Analyzing ' + importedRows.toLocaleString('en-IN') + ' rows…';
    await new Promise(resolve => setTimeout(resolve, 0));
    return importer.finish(source);
  }
  function importText(text, source) {
    const rows = parseCsv(text);
    if (rows.length === 1) {
      const headers = rows[0].map(normalize);
      const needed = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'];
      if (needed.every(key => headers.includes(key))) {
        stocks.splice(0, stocks.length);
        if (saveCandlesButton) saveCandlesButton.disabled = true;
        document.querySelector('.sample-pill').textContent = '● CSV TEMPLATE · NO MARKET DATA';
        document.querySelector('.market-pill').innerHTML = '<i></i>' + safeHtml(source);
        note.innerHTML = '<strong>CSV template connected, but it has no candle rows yet.</strong> Add verified OHLCV rows to GitHub before expecting prices or Zone Analysis.';
        document.queryestor('#tabs [data-view="candles"]')?.click();
        render();
        message('CSV headings found; no market rows yet');
        return;
      }
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
    if (url.hostname === 'expert-gyasho.github.io') {
      if (url.pathname !== '/shivshakti-screener-data/candles.csv.gz') {
        throw new Error('Shivshakti Pages ke published candles.csv.gz link ka use kijiye.');
      }
      url.search = ''; url.hash = '';
    }
    if (!['raw.githubusercontent.com', 'gist.githubusercontent.com', 'expert-gyasho.github.io'].includes(url.hostname) || url.protocol !== 'https:') {
      throw new Error('Public GitHub CSV link daaliye. Private repo links supported nahi hain.');
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
      await importLargeCandleStream(response, `GitHub CSV · ${new Date().toLocaleTimeString('en-IN')}`);
      if (isAuto) message('GitHub CSV auto-reload complete.');
    } catch (error) { message(error.message || 'GitHub CSV load failed'); }
    finally { loadButton.disabled = false; loadButton.textContent = original; }
  }

  try {
    const savedUrl = localStorage.getItem('shivshakti-csv-url');
    const oldDefaultUrl = 'https://github.com/expert-gyasho/shivshakti-screener-data/blob/main/candles.csv';
    const lifetimeUrl = 'https://github.com/expert-gyasho/shivshakti-screener-data/blob/main/candles.csv.gz';
    const siteFeedUrl = 'https://expert-gyasho.github.io/shivshakti-screener-data/candles.csv.gz';
    if ([oldDefaultUrl, lifetimeUrl].includes(savedUrl)) {
      urlInput.value = siteFeedUrl;
      localStorage.setItem('shivshakti-csv-url', siteFeedUrl);
    } else if (savedUrl && urlInput) urlInput.value = savedUrl;
    else if (urlInput) urlInput.value = siteFeedUrl;
    const savedAutoReload = localStorage.getItem('shivshakti-csv-auto-reload');
    const autoReloadPreferenceVersion = localStorage.getItem('shivshakti-csv-auto-reload-v3');
    // This screener is expected to show the published full history automatically.
    const enabled = autoReloadPreferenceVersion === 'true' ? savedAutoReload === 'true' : true;
    if (autoReload) autoReload.checked = enabled;
    if (autoReloadPreferenceVersion !== 'true') {
      localStorage.setItem('shivshakti-csv-auto-reload', 'true');
      localStorage.setItem('shivshakti-csv-auto-reload-v3', 'true');
    }
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