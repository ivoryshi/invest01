import { mountLegacyModule } from './module-loader.js';
import { fundComparisonGroupValue, fundMetadataEditPayload, isCurrentFundEdit, refreshSnapshotChoices } from './fund-screen-state.js';
import { industrySaveMethod, latestIndustryConfig, nextIndustryConfigId } from './industry-state.js';
import { accountModeSeries, compareCurves, csvText, effectiveCosts, resultComparisonKey } from './factor-analysis.js';

document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('#workbench-main').focus();
});
const nav = document.querySelector('#workbench-nav');
const content = document.querySelector('#workbench-content');
let cleanup = null;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(error) {
  content.replaceChildren(element('h1', '工作区加载失败'), element('p', `${error.message}。请确认本地服务已启动后刷新。`));
}
async function researchPanel() {
  const panel = element('section', null, 'research-native');
  const [skillsResponse, reportsResponse] = await Promise.all([
    fetch('/api/modules/research/v1/skills'),
    fetch('/api/modules/research/v1/artifacts?limit=8'),
  ]);
  if (!skillsResponse.ok || !reportsResponse.ok) throw new Error('研究生产索引暂不可用');
  const skills = await skillsResponse.json();
  const reports = await reportsResponse.json();
  const stages = element('div', null, 'grid');
  for (const stage of skills.stages) {
    const card = element('article', null, 'card');
    card.append(element('small', 'WORKFLOW'), element('h3', stage.stage), element('p', `${stage.items.length} 个 Skill；${stage.items.filter(x => x.live).length} 个源项目标记为实时执行。`), element('p', stage.items.map(x => x.cmd).join(' · '), 'next'));
    stages.append(card);
  }
  const artifacts = element('section', null, 'empty');
  artifacts.append(element('span', '产出查询 · 只读', 'status'), element('h2', '最近报告产出'), element('p', '读取源项目 reports 目录的文件名、大小和修改时间，不读取密钥、不执行旧任务。'));
  for (const item of reports.items) {
    const row = element('a', `${item.title} · ${item.updatedAt.slice(0, 10)}`, 'report-link');
    row.href = `/api/modules/research/v1/artifacts/${encodeURIComponent(item.file)}`;
    row.target = '_blank';
    row.rel = 'noopener';
    artifacts.append(row);
  }
  panel.append(element('p', '首批能力：Skill 注册表 / 工作流入口 / 产出查询。实时执行、工具授权和任务恢复待后续批次。', 'intro'), stages, artifacts);
  return panel;
}
async function contractPanel() {
  const [contractResponse, factorResponse, sourceResponse, artifactResponse, entityResponse] = await Promise.all([
    fetch('/api/contracts/v1/core'),
    fetch('/api/contracts/v1/factors'),
    fetch('/api/registry/v1/sources'),
    fetch('/api/registry/v1/artifacts?limit=8'),
    fetch('/api/registry/v1/entities?limit=8'),
  ]);
  if (!contractResponse.ok || !factorResponse.ok || !sourceResponse.ok || !artifactResponse.ok || !entityResponse.ok) throw new Error('核心契约暂不可用');
  const contract = await contractResponse.json();
  const factorContract = await factorResponse.json();
  const sources = await sourceResponse.json();
  const artifacts = await artifactResponse.json();
  const entities = await entityResponse.json();
  const panel = element('section', null, 'research-native');
  const grid = element('div', null, 'grid');
  for (const group of [
    ['实体', contract.entityTypes.length, contract.entityTypes.map(x => x.label).join(' / ')],
    ['来源字段', contract.sourceRecord.required.length, contract.sourceRecord.required.join(' / ')],
    ['产出字段', contract.artifactRecord.required.length, contract.artifactRecord.required.join(' / ')],
    ['任务状态', contract.taskRecord.statuses.length, contract.taskRecord.statuses.join(' / ')],
    ['来源索引', sources.count, '观察台来源已映射为统一 source record'],
    ['产出索引', artifacts.count, '观察台配置与研究生产报告已映射为 artifact record'],
    ['实体索引', entities.count, '观察台指数、公司、指标和叙事已映射为 entity record'],
    ['因子实验契约', factorContract.experimentRecord.required.length, '快照、因子定义、实验设置、比较限制和结果artifact已先行固定'],
  ]) {
    const card = element('article', null, 'card');
    card.append(element('small', 'CORE CONTRACT'), element('h3', `${group[0]} · ${group[1]}`), element('p', group[2]));
    grid.append(card);
  }
  panel.append(element('p', '当前主线：先固定跨模块实体、来源、产出和任务状态。日报生产已暂停，只保留历史入口。', 'intro'), grid);
  return panel;
}
function formValue(form, name) {
  return form.elements[name]?.value?.trim() || '';
}
function splitList(value) {
  return value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
}
function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function option(value, label = value) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}
function fmtPct(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}
function fmtNum(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return Number(value).toFixed(digits);
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function lineChart(series, options = {}) {
  const width = 760;
  const height = options.height || 260;
  const pad = { l: 46, r: 18, t: 18, b: 30 };
  const items = options.items || [];
  const logScale = options.scale === 'log';
  const valid = point => point && typeof point.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(Date.parse(point.date)) && Number.isFinite(point.value) && (!logScale || point.value > 0);
  const rows = items.flatMap(item => (series[item.key] || []).filter(valid));
  const values = rows.map(point => point.value);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'native-chart', role: 'img', 'aria-label': options.label || '日期对齐的序列图' });
  if (!rows.length) {
    const text = svg('text', { x: pad.l, y: height / 2, class: 'chart-axis' });
    text.textContent = '无可显示的有效观测'; root.append(text); return root;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const transform = value => logScale ? Math.log(value) : value;
  const span = transform(max) - transform(min) || 1;
  const dates = rows.map(point => point.date).sort();
  const first = dates[0], last = dates.at(-1), start = Date.parse(first), duration = Date.parse(last) - start || 1;
  root.chartDateDomain = [start, Date.parse(last)];
  const coordinates = point => [pad.l + (width - pad.l - pad.r) * (Date.parse(point.date) - start) / duration,
    pad.t + (height - pad.t - pad.b) * (1 - (transform(point.value) - transform(min)) / span)];
  for (let i = 0; i < 4; i++) {
    const y = pad.t + (height - pad.t - pad.b) * (i / 3);
    root.append(svg('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, class: 'chart-grid' }));
  }
  for (const item of items) {
    const data = series[item.key] || [];
    let segment = [];
    const flush = () => {
      if (segment.length) root.append(svg('polyline', { points: segment.join(' '), fill: 'none', stroke: item.color, 'stroke-width': item.width || 2.1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      segment = [];
    };
    for (const point of data) {
      if (!valid(point)) { flush(); continue; }
      const [x, y] = coordinates(point);
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const dot = svg('circle', { cx: x, cy: y, r: 3, fill: item.color, opacity: 0.6 });
      const title = svg('title'); title.textContent = `${item.name || item.key} · ${point.date} · ${fmtNum(point.value, 4)}`;
      dot.append(title); root.append(dot);
    }
    flush();
  }
  for (const marker of options.markers || []) {
    if (!valid(marker) || marker.date < first || marker.date > last) continue;
    const [x,y]=coordinates(marker), mark=svg('circle',{cx:x,cy:y,r:5,fill:marker.status==='pause'?'#fff':'#a62536',stroke:marker.status==='pause'?'#555':'#a62536','stroke-width':2});
    const title=svg('title');title.textContent=`${marker.status==='pause'?'停投':'买入'} · ${marker.date} · ${marker.label || ''}`;mark.append(title);root.append(mark);
  }
  for (const label of [
    { x: pad.l, y: height - 8, text: first },
    { x: width - pad.r - 80, y: height - 8, text: last },
    { x: 8, y: pad.t + 8, text: fmtNum(max, 2) },
    { x: 8, y: height - pad.b, text: fmtNum(min, 2) },
  ]) {
    const text = svg('text', { x: label.x, y: label.y, class: 'chart-axis' });
    text.textContent = label.text;
    root.append(text);
  }
  return root;
}
function chartWorkspace(series, options = {}) {
  const node = element('section'), controls = element('div'), plot = element('div'), status = element('p', '', 'next');
  const dates = Object.values(series).flat().filter(p => Number.isFinite(p.value)).map(p => p.date).sort();
  const start = document.createElement('input'), end = document.createElement('input'), scale = document.createElement('select');
  start.type = end.type = 'date'; start.value = dates[0] || ''; end.value = dates.at(-1) || '';
  start.setAttribute('aria-label', `${options.label || '图表'}开始日期`); end.setAttribute('aria-label', `${options.label || '图表'}结束日期`);
  scale.setAttribute('aria-label', `${options.label || '图表'}坐标`); scale.append(option('linear', '线性'), option('log', '对数（正值）'));
  function draw() {
    if (start.value > end.value) { plot.replaceChildren(); status.textContent = '开始日期晚于结束日期'; return; }
    const filtered = Object.fromEntries(Object.entries(series).map(([key, rows]) => [key, rows.filter(p => p.date >= start.value && p.date <= end.value)]));
    const chart = lineChart(filtered, { ...options, scale: scale.value });
    status.textContent = `${start.value} → ${end.value}${scale.value === 'log' ? ' · 非正值不显示' : ''}`;
    chart.addEventListener('wheel', event => { if (!event.ctrlKey) return; event.preventDefault(); zoom(event.deltaY < 0 ? .5 : 2); }, { passive: false });
    let dragStart = null;
    const chartDate = event => {
      const box = chart.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - box.left - box.width * 46/760) / (box.width * (760-46-18)/760)));
      const [lo, hi] = chart.chartDateDomain;
      return new Date(lo + fraction * (hi - lo)).toISOString().slice(0,10);
    };
    chart.addEventListener('pointerdown', event => { if (event.button === 0 && chart.chartDateDomain) { dragStart = chartDate(event); chart.setPointerCapture(event.pointerId); } });
    chart.addEventListener('pointerup', event => { if (!dragStart) return; const release = chartDate(event), pair = [dragStart, release].sort(); dragStart = null; if (pair[0] !== pair[1]) { start.value=pair[0];end.value=pair[1];draw(); } });
    chart.addEventListener('pointercancel', () => { dragStart = null; });
    plot.replaceChildren(chart);
  }
  function zoom(ratio) {
    const lo=Date.parse(start.value),hi=Date.parse(end.value); if (!Number.isFinite(lo) || hi<=lo) return;
    const half=(hi-lo)*ratio/2, center=(hi+lo)/2;
    start.value=new Date(Math.max(Date.parse(dates[0]),center-half)).toISOString().slice(0,10);
    end.value=new Date(Math.min(Date.parse(dates.at(-1)),center+half)).toISOString().slice(0,10);draw();
  }
  const presets = document.createElement('select'); presets.setAttribute('aria-label', `${options.label || '图表'}快捷区间`);
  presets.append(option('all', '全部'), option('1', '近1年'), option('3', '近3年'));
  presets.addEventListener('change', () => { end.value=dates.at(-1)||'';const bound=new Date(end.value);if(presets.value!=='all'&&end.value){bound.setUTCFullYear(bound.getUTCFullYear()-Number(presets.value));start.value=[dates[0],bound.toISOString().slice(0,10)].sort().at(-1);}else start.value=dates[0]||'';draw(); });
  for (const [title,text,action] of [['放大','+',()=>zoom(.5)],['缩小','-',()=>zoom(2)],['复位','↺',()=>{start.value=dates[0]||'';end.value=dates.at(-1)||'';presets.value='all';draw();}]]) {
    const button=element('button',text);button.type='button';button.title=title;button.setAttribute('aria-label',`${options.label || '图表'}${title}`);button.addEventListener('click',action);controls.append(button);
  }
  const download=element('button','下载图 SVG');download.type='button';download.addEventListener('click',()=>{
    const chart=plot.querySelector('svg');if(!chart)return;
    const copy=chart.cloneNode(true),style=svg('style');style.textContent='.chart-axis,.chart-label{fill:#263d35;font:12px sans-serif}.chart-grid{stroke:#dce2de}';copy.prepend(style);
    downloadFactorFile(new XMLSerializer().serializeToString(copy),'image/svg+xml',`factor-chart-${start.value}-${end.value}.svg`);
  });controls.append(download);
  start.addEventListener('change',draw);end.addEventListener('change',draw);scale.addEventListener('change',draw);
  controls.prepend(start,end,presets,scale);node.append(controls,status,plot);
  node.setItems = items => { options = { ...options, items }; draw(); };
  draw();return node;
}
function barTrack(item, maxAbs) {
  const row = element('article', null, 'attrib-row');
  const head = element('div', null, 'attrib-head');
  head.append(element('span', item.label), element('b', fmtPct(item.value)));
  const track = element('div', null, 'attrib-track');
  const zero = element('i', null, 'zero');
  zero.style.left = '50%';
  const fill = element('i', null, item.value >= 0 ? 'fill pos-fill' : 'fill neg-fill');
  const width = Math.min(50, Math.abs(item.value) / maxAbs * 50);
  fill.style.width = `${width}%`;
  fill.style.left = item.value >= 0 ? '50%' : `${50 - width}%`;
  track.append(zero, fill);
  row.append(head, track, element('p', item.notes, 'next'));
  return row;
}
function metricValue(value, unit = 'number') {
  if (unit === 'pct') return fmtPct(value);
  return fmtNum(value);
}
async function factorVisualLabPanel() {
  const response = await fetch('/api/modules/factors/v1/visual-lab');
  if (!response.ok) throw new Error('因子实验台可视化数据暂不可用');
  const data = await response.json();
  const panel = element('section', null, 'factor-visual-lab');
  const title = element('section', null, 'visual-hero');
  title.append(
    element('small', 'FACTOR LAB / EXPORTED BACKTEST VIEW'),
    element('h2', '策略实验驾驶舱'),
    element('p', '这一层迁移旧因子实验台的交互和图表：策略对比、定投账户曲线、因子定位、归因拆解和敏感度。当前读取旧项目已导出的结果，不重新运行回测。'),
  );
  const kpis = element('section', null, 'visual-kpis');
  for (const item of [
    ['策略 IRR', fmtPct(data.kpis.strategyIrr), `基准 ${fmtPct(data.kpis.benchmarkIrr)}`],
    ['IRR 超额', fmtPct(data.kpis.irrExcess), `${data.kpis.months} 个月`],
    ['策略终值', fmtNum(data.kpis.strategyFinal), `基准 ${fmtNum(data.kpis.benchmarkFinal)}`],
    ['TWR CAGR', fmtPct(data.kpis.twrStrategy.cagr), `MDD ${fmtPct(data.kpis.twrStrategy.mdd)}`],
    ['波动率', fmtPct(data.kpis.twrStrategy.vol), `Sharpe ${fmtNum(data.kpis.twrStrategy.sharpe)}`],
    ['成本', fmtNum(data.kpis.totalCost), data.period.join(' → ')],
  ]) {
    const card = element('article', null, 'visual-kpi');
    card.append(element('small', item[0]), element('strong', item[1]), element('span', item[2]));
    kpis.append(card);
  }
  const dashboard = element('section', null, 'visual-dashboard');
  const controls = element('aside', null, 'visual-controls');
  const chartBox = element('article', null, 'visual-chart-card');
  const selected = new Set(['spec', 'opt', 'hs300', 'sA', 'sB', 'sC']);
  const meta = new Map(data.seriesMeta.map(item => [item.key, item]));
  const legend = element('div', null, 'visual-legend');
  let strategyChart;
  function drawStrategyChart() {
    const items = [...selected].map(key => ({ key, color: meta.get(key)?.color || '#4C8DFF' }));
    if (!strategyChart) strategyChart = chartWorkspace(data.series, { items, height: 300, label: '策略净值' });
    else strategyChart.setItems(items);
    chartBox.replaceChildren(element('h3', '策略净值与分档对比'), strategyChart);
  }
  for (const item of data.seriesMeta) {
    const label = element('label', null, 'visual-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected.has(item.key);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(item.key);
      else selected.delete(item.key);
      drawStrategyChart();
    });
    const swatch = element('i');
    swatch.style.background = item.color;
    label.append(input, swatch, element('span', item.name));
    legend.append(label);
  }
  const cfg = data.config;
  controls.append(element('h3', '配置旋钮'), legend);
  for (const item of [
    ['PE闸门', `${(cfg.pe_gate * 100).toFixed(0)} 分位`],
    ['行业TopN', cfg.top_n],
    ['最大持有', `${cfg.max_hold}月`],
    ['佣金+滑点', `${fmtPct(cfg.commission + cfg.slippage, 3)}`],
    ['行业费率', fmtPct(cfg.fee_sector, 2)],
    ['最少可投行业', cfg.min_inv],
  ]) {
    const row = element('div', null, 'config-chip');
    row.append(element('span', item[0]), element('b', String(item[1])));
    controls.append(row);
  }
  dashboard.append(controls, chartBox);
  drawStrategyChart();
  const curveGrid = element('section', null, 'visual-two-col');
  const accountCard = element('article', null, 'visual-chart-card');
  accountCard.append(
    element('h3', '账户价值 / 单位净值 / 投入成本'),
    chartWorkspace(data.account, { height: 260, label: '历史账户', items: [
      { key: 'strategy', color: '#2ED3A0' },
      { key: 'bench_dca', color: '#C9D1DC' },
      { key: 'contributed', color: '#FFB020', width: 1.6 },
    ] }),
  );
  const sleeveCard = element('article', null, 'sleeve-card');
  sleeveCard.append(element('h3', 'A/B/C 分档贡献'));
  for (const item of data.sleeve) {
    const row = element('div', null, 'sleeve-row');
    row.append(element('span', item.name), element('b', `${fmtNum(item.final)} / ${fmtPct(item.irr)}`));
    sleeveCard.append(row);
  }
  curveGrid.append(accountCard, sleeveCard);
  const factorGrid = element('section', null, 'visual-two-col');
  const positioning = element('article', null, 'visual-chart-card');
  const positionMode = document.createElement('select'); positionMode.setAttribute('aria-label', '因子定位横轴');
  positionMode.append(option('solo', '单因子超额'), option('rule', '规则化程度（旧定性标注）'));
  const positionView = element('div');
  const drawPosition = () => positionView.replaceChildren(positioningPlot(data.factorPositioning, positionMode.value),
    element('p', positionMode.value === 'rule' ? '规则化程度为旧定义的定性判断，不是实测Alpha或新的因子评分。' : '单因子超额与留一法边际贡献来自旧导出，不是本次新执行。', 'next'));
  positionMode.addEventListener('change', drawPosition); drawPosition();
  positioning.append(element('h3', '因子定位图'), positionMode, positionView);
  const attribution = element('article', null, 'visual-chart-card');
  attribution.append(element('h3', 'Alpha / Smart Beta / 残差归因'));
  const maxAbs = Math.max(...data.factorStudy.attribution.map(item => Math.abs(item.value)), 0.01);
  for (const item of data.factorStudy.attribution) attribution.append(barTrack(item, maxAbs));
  factorGrid.append(positioning, attribution);
  const sensitivity = element('section', null, 'visual-table-card');
  sensitivity.append(element('h3', '敏感度与口径对比'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>情景</th><th>IRR</th><th>超额</th><th>TWR</th><th>最大回撤</th><th>终值</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const item of data.sensitivity) {
    const tr = document.createElement('tr');
    for (const value of [item.case, fmtPct(item.irr), fmtPct(item.excess), fmtPct(item.twr), fmtPct(item.mdd), fmtNum(item.final)]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  sensitivity.append(table, element('p', data.factorStudy.verdict, 'warning'));
  panel.append(title, kpis, dashboard, curveGrid, factorGrid, sensitivity);
  return panel;
}
async function experimentComparisonPanel() {
  const response = await fetch('/api/modules/factors/v1/experiment-comparison');
  if (!response.ok) throw new Error('实验组合对比暂不可用');
  const data = await response.json();
  const panel = element('section', null, 'experiment-comparison-panel');
  const head = element('section', null, 'comparison-head');
  head.append(
    element('small', 'EXPERIMENT COMPARISON'),
    element('h2', '实验组合对比'),
    element('p', '读取旧实验室导出的多方案净值序列，原生重建 A/B/C 组合、因子权重方案、PE闸门和基准对比。当前只重算对比指标，不重新回测。'),
  );
  const summary = element('section', null, 'comparison-summary');
  for (const item of [
    ['对比序列', data.count],
    ['B组权重方案', data.variants.length],
    ['月度索引', data.monthIndexCount],
    ['口径', '同区间净值比较，非IRR排名'],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const chartCard = element('article', null, 'comparison-card wide-card');
  const selected = new Set(['C', 'B_base', 'B_equal', 'A_hs300_gate']);
  const seriesMap = Object.fromEntries(data.items.map(item => [item.key, item.series]));
  const colors = ['#2ED3A0', '#4C8DFF', '#FFB020', '#E85D75', '#8FD14F', '#B987F5', '#46B8E0', '#C9D1DC'];
  const range = element('section'), start = document.createElement('input'), end = document.createElement('input'), baseline = document.createElement('select');
  start.type = end.type = 'date'; start.value = data.period[0]; end.value = data.period[1];
  start.setAttribute('aria-label','对比开始日期');end.setAttribute('aria-label','对比结束日期');baseline.setAttribute('aria-label','对比基线');
  data.items.forEach(item=>baseline.append(option(item.key,item.label)));baseline.value=data.baselineKey;
  range.append(start,end,baseline);
  let rankBody;
  function renderChart() {
    const comparison = compareCurves(seriesMap, [...selected], baseline.value, start.value, end.value);
    const chartItems = data.items
      .filter(item => selected.has(item.key))
      .map(item => ({ key: item.key, name:item.label, color: colors[data.items.indexOf(item) % colors.length], width: item.key === baseline.value ? 2.8 : 2 }));
    chartCard.replaceChildren(
      element('h3', '组合净值对比'),
      lineChart(comparison.series, { items: chartItems, height: 280 }),
      element('p', comparison.period ? `${comparison.period.join(' → ')} · ${comparison.observationCount}个同日期观测 · 起点归一为1 · 基线${baseline.value} · 实际日历年化，非账户IRR` : `不能比较：${comparison.status}`, 'next'),
    );
    if (rankBody) {
      rankBody.replaceChildren();
      for (const row of comparison.items) {
        const item=data.items.find(item=>item.key===row.key), tr=document.createElement('tr');
        [item.label,comparison.period.join(' → '),fmtNum(row.finalValue,4),fmtPct(row.annualizedReturn),fmtPct(row.maxDrawdown),fmtPct(row.excessAnnualizedReturn)].forEach(value=>tr.append(element('td',value)));
        rankBody.append(tr);
      }
    }
  }
  [start,end,baseline].forEach(input=>input.addEventListener('change',renderChart));
  const selector = element('section', null, 'comparison-selector');
  for (const item of data.items) {
    const label = element('label', null, 'visual-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected.has(item.key);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(item.key);
      else selected.delete(item.key);
      renderChart();
    });
    const swatch = element('i');
    swatch.style.background = colors[data.items.indexOf(item) % colors.length];
    label.append(input, swatch, element('span', `${item.key} · ${item.label}`));
    selector.append(label);
  }
  renderChart();
  const grid = element('section', null, 'comparison-grid');
  const ranking = element('article', null, 'comparison-card wide-card');
  ranking.append(element('h3', '方案排名与指标'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>方案</th><th>共同区间</th><th>归一终值</th><th>净值年化</th><th>回撤</th><th>相对基线</th></tr></thead>';
  const tbody = document.createElement('tbody');
  rankBody = tbody; renderChart();
  table.append(tbody);
  ranking.append(table);
  const variants = element('article', null, 'comparison-card wide-card');
  variants.append(element('h3', 'B组因子权重方案'));
  for (const item of data.variants) {
    const row = element('div', null, 'data-row');
    row.append(
      element('span', `${item.key} · ${item.label}`),
      element('b', Object.entries(item.weights).map(([key, value]) => `${key}:${fmtPct(value, 1)}`).join(' / ')),
    );
    variants.append(row);
  }
  grid.append(range, chartCard, selector, ranking, variants);
  const notes = element('section', null, 'product-notes');
  notes.append(element('h3', '对比边界'));
  for (const note of data.notes) notes.append(element('p', note));
  panel.append(head, summary, grid, notes);
  return panel;
}
async function factorProductConsolePanel() {
  const response = await fetch('/api/modules/factors/v1/product-state');
  if (!response.ok) throw new Error('因子实验室产品状态暂不可用');
  const state = await response.json();
  const panel = element('section', null, 'factor-product-console');
  const hero = element('section', null, 'product-console-hero');
  hero.append(
    element('small', 'FACTOR LAB PRODUCT MIGRATION'),
    element('h2', '因子实验室产品控制台'),
    element('p', '本区保留旧导出结果参照；新回测通过下方显式配置和执行请求生成独立结果，口径与版本分别保留。'),
  );
  const workflow = element('section', null, 'workflow-rail');
  for (const item of state.workflow) {
    const card = element('article', null, 'workflow-step');
    card.append(element('small', item.status), element('h3', item.title), element('p', item.output));
    workflow.append(card);
  }
  const tools = element('section', null, 'product-console-grid');
  const strategyTools = element('article', null, 'product-console-card');
  strategyTools.append(element('h3', '策略工具覆盖'));
  for (const item of state.strategyTools) {
    const row = element('div', null, 'tool-row');
    row.append(
      element('span', item.title),
      element('b', item.editableNow ? '可配置' : '待扩展'),
      element('small', `${item.strategyType} · 草案 ${item.savedConfigCount}`),
    );
    strategyTools.append(row);
  }
  const custom = element('article', null, 'product-console-card');
  custom.append(
    element('h3', '自建因子策略'),
    element('p', state.customFactorBuilder.defaultTemplate.customFormula),
    element('p', `字段：${state.customFactorBuilder.fields.join(' / ')}`, 'next'),
  );
  for (const rule of state.customFactorBuilder.validationRules) custom.append(element('span', rule, 'pill'));
  tools.append(strategyTools, custom);
  const resultGrid = element('section', null, 'product-console-grid');
  const metrics = element('article', null, 'product-console-card wide-card');
  metrics.append(element('h3', 'Portfolio 核心指标对比'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>指标</th><th>策略</th><th>基准</th><th>差异</th><th>说明</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const item of state.resultComparison.metrics) {
    const tr = document.createElement('tr');
    for (const value of [item.metric, metricValue(item.strategy, item.unit), metricValue(item.benchmark, item.unit), metricValue(item.excess, item.unit), item.interpretation]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  metrics.append(table);
  const scoring = element('article', null, 'product-console-card');
  scoring.append(
    element('h3', '打分与回测逻辑'),
    element('p', state.scoringAndBacktestLogic.factorScoreFormula),
    element('p', state.scoringAndBacktestLogic.timingGate, 'next'),
  );
  const steps = element('ol', null, 'logic-steps');
  for (const step of state.scoringAndBacktestLogic.steps) steps.append(element('li', step));
  scoring.append(steps);
  resultGrid.append(metrics, scoring);
  const positioning = element('section', null, 'product-console-grid');
  const posCard = element('article', null, 'product-console-card');
  posCard.append(element('h3', '当前配置因子定位'));
  for (const item of state.factorPositioning) {
    const row = element('div', null, 'position-row');
    row.append(element('span', item.label), element('b', item.position), element('small', `权重 ${fmtPct(item.currentWeight, 1)} · 边际 ${fmtPct(item.marginalContribution)}`));
    posCard.append(row);
  }
  const errors = element('article', null, 'product-console-card');
  errors.append(element('h3', '误差与风险归因'));
  for (const item of state.errorModel) {
    const row = element('div', null, 'error-row');
    row.append(element('b', item.title), element('p', item.logic), element('small', item.mitigation));
    errors.append(row);
  }
  positioning.append(posCard, errors);
  const notes = element('section', null, 'product-notes');
  notes.append(element('h3', '数据口径和迁移边界'));
  for (const note of state.dataScopeNotes) notes.append(element('p', note));
  panel.append(hero, workflow, tools, resultGrid, positioning, notes);
  return panel;
}
let refreshDcaSnapshotChoices = null;
let refreshFundSnapshotChoices = null;
let refreshIndustrySnapshotChoices = null;
let editIndustryConfig = null;
let refreshThreeBucketSnapshotChoices = null;
let editThreeBucketConfig = null;
let editFundNavConfig = null;
let refreshFundNavSnapshotChoices = null;
let refreshFrozenSnapshotList = null;
let refreshBacktestTools = null;
let editExpressionFactor = null;
let editExpressionConfig = null;

async function populateSnapshotSelect(select, baseSnapshotId) {
  await refreshSnapshotChoices(select, { baseSnapshotId, makeOption: (value, label) => option(value, value === baseSnapshotId ? '当前原文件（随更新变化）' : label.replace('Unavailable:', '原配置快照不可用：')), load: async () => {
    const response = await fetch('/api/modules/factors/v1/snapshots/frozen');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '冻结快照列表读取失败');
    return data;
  } });
}

async function frozenSnapshotPanel() {
  const panel = element('section', null, 'frozen-snapshot-panel wide-card');
  panel.append(element('h3', '冻结数据版本'));
  const form = document.createElement('form');
  form.className = 'strategy-grid-form';
  form.innerHTML = '<label>数据类型<select name="baseSnapshotId"></select></label><label>版本标题<input name="title" maxlength="160" placeholder="例如：2026-10月研究基线"></label><button type="submit">冻结本地数据副本</button>';
  const message = element('p', '', 'form-message'); message.setAttribute('role', 'status');
  const list = element('div', null, 'frozen-snapshot-list');
  async function renderList() {
    const response = await fetch('/api/modules/factors/v1/snapshots/frozen');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '冻结快照读取失败');
    const selected = form.elements.baseSnapshotId.value;
    form.elements.baseSnapshotId.replaceChildren();
    data.freezeOptions.filter(item => !item.selectionRequired).forEach(item => form.elements.baseSnapshotId.append(option(item.baseSnapshotId, item.title)));
    if (selected) form.elements.baseSnapshotId.value = selected;
    list.replaceChildren();
    if (!data.items.length) list.append(element('p', '尚无冻结版本。', 'next'));
    for (const item of data.items) {
      const row = element('div', null, 'frozen-snapshot-row');
      row.append(element('b', item.title || item.snapshotId), element('p', `${item.snapshotId} · ${item.status} · ${item.createdAt || '-'}`));
      if (item.status === 'frozen') {
        row.append(element('small', item.files.map(file => `${file.fileName}：${file.bytes}字节 / SHA ${file.sha256}`).join('\n')));
        const verify = element('button', '校验内容'); verify.type = 'button';
        const status = element('p', '本次列表未检查文件内容。', 'next'); status.setAttribute('role', 'status');
        verify.addEventListener('click', async () => {
          verify.disabled = true;
          try {
            const response = await fetch(`/api/modules/factors/v1/snapshots/frozen/${item.snapshotId}/verify`, { method: 'POST' });
            const data = await response.json();
            status.textContent = response.ok ? 'SHA-256校验通过' : `校验失败：${data.error}`;
          } catch (error) { status.textContent = error.message; }
          finally { verify.disabled = false; }
        });
        row.append(verify, status);
      } else row.append(element('p', item.error, 'warning'));
      list.append(row);
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      const response = await fetch('/api/modules/factors/v1/snapshots/frozen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseSnapshotId: formValue(form, 'baseSnapshotId'), title: formValue(form, 'title') }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '冻结失败');
      message.textContent = `已冻结并校验：${data.snapshotId}`;
      await renderList(); await refreshDcaSnapshotChoices?.(); await refreshFundSnapshotChoices?.(); await refreshIndustrySnapshotChoices?.(); await refreshThreeBucketSnapshotChoices?.(); await refreshFundNavSnapshotChoices?.();
    } catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  refreshFrozenSnapshotList = async () => { if (panel.isConnected) await renderList(); };
  panel.append(form, message, element('p', '单次冻结上限64MiB。基金数据库须在基金配置中绑定选定份额与基准后冻结，不复制整库。冻结时间不是数据截止日或历史可得时间，本地副本不是外部备份。', 'next'), list);
  try { await renderList(); } catch (error) { message.textContent = error.message; }
  return panel;
}

async function factorDataLayerPanel() {
  const [response, schemaResponse] = await Promise.all([
    fetch('/api/modules/factors/v1/data-layer'),
    fetch('/api/modules/factors/v1/data-layer/schema'),
  ]);
  if (!response.ok || !schemaResponse.ok) throw new Error('因子数据层暂不可用');
  const data = await response.json();
  const schema = await schemaResponse.json();
  const panel = element('section', null, 'factor-data-layer');
  const head = element('section', null, 'data-layer-head');
  head.append(
    element('small', 'DATA LAYER'),
    element('h2', '数据宽表与月度更新管理'),
    element('p', '历史宽表、面板、数据版本、字段字典与月度更新任务。'),
  );
  const summary = element('section', null, 'data-layer-summary');
  for (const item of [
    ['数据资产', data.assetCount],
    ['快照候选', data.snapshotCount],
    ['更新任务', data.updateJobCount],
    ['历史导出', data.legacyExportCount],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const grid = element('section', null, 'data-layer-grid');
  const assets = element('article', null, 'data-layer-card');
  assets.append(element('h3', '宽表与面板资产'));
  for (const item of data.assets) {
    const row = element('div', null, 'data-row');
    row.append(
      element('span', item.title),
      element('b', item.exists ? '已发现' : '待确认'),
      element('small', `${item.refreshMode} · ${item.assetType} · ${item.storageRef}`),
    );
    assets.append(row);
  }
  const jobs = element('article', null, 'data-layer-card');
  jobs.append(element('h3', '月度更新任务'));
  for (const item of data.updateJobs) {
    const row = element('div', null, 'data-row');
    row.append(
      element('span', item.title),
      element('b', item.status),
      element('small', `${item.frequency} · ${item.networkPolicy}`),
    );
    jobs.append(row);
  }
  const exports = element('article', null, 'data-layer-card wide-card');
  exports.append(element('h3', '旧实验结果资产迁移目录'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>文件</th><th>类型</th><th>大小</th><th>迁移状态</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const item of data.legacyExports) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.artifactType, fmtNum(item.bytes), item.migrationStatus]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  exports.append(table);
  const schemaCard = element('article', null, 'data-layer-card wide-card');
  schemaCard.append(element('h3', '字段与Schema探针'));
  const schemaTable = document.createElement('table');
  schemaTable.innerHTML = '<thead><tr><th>资产</th><th>状态</th><th>字段数</th><th>样例字段</th></tr></thead>';
  const schemaBody = document.createElement('tbody');
  for (const item of schema.items) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.status, item.fieldCount, (item.sampleFields || []).join(' / ') || item.rowShape || '-']) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    schemaBody.append(tr);
  }
  schemaTable.append(schemaBody);
  schemaCard.append(schemaTable);
  grid.append(assets, jobs, await frozenSnapshotPanel(), schemaCard, factorDataPreviewWorkspace(data.assets, schema.items), exports);
  const notes = element('section', null, 'product-notes');
  notes.append(element('h3', '数据边界'));
  for (const note of data.notes) notes.append(element('p', note));
  for (const note of schema.notes) notes.append(element('p', note));
  panel.append(head, summary, grid, notes);
  return panel;
}

function factorDataPreviewWorkspace(assets, schemas) {
  const workspace = element('section', null, 'data-preview-workspace wide-card');
  workspace.append(element('h3', '历史数据查询'));
  const form = document.createElement('form');
  form.className = 'studio-form';
  form.innerHTML = `<div class="form-grid">
    <label>数据资产<select name="assetId" required></select></label>
    <label>关键词<input name="q" maxlength="100"></label>
    <label>日期字段<select name="dateField"></select></label>
    <label>样本行数<input name="limit" type="number" min="1" max="50" value="20" required></label>
    <label>开始日期<input name="startDate" type="date"></label>
    <label>结束日期<input name="endDate" type="date"></label>
  </div><fieldset class="preview-fields"><legend>查询字段</legend></fieldset>
  <button type="submit">查询数据</button>`;
  const choices = assets.filter(item => item.exists && /\.(csv|parquet)$/.test(item.storageRef));
  for (const item of choices) form.elements.assetId.append(option(item.assetId, item.title));
  const fields = form.querySelector('.preview-fields');
  const dictionary = element('div', null, 'preview-dictionary');
  const results = element('section', null, 'preview-results');
  results.setAttribute('aria-live', 'polite');
  const next = element('button', '下一批样本');
  next.type = 'button';
  next.hidden = true;
  let nextOffset = null;
  let lastQuery = null;
  let sourceVersion = null;
  let generation = 0;
  const messages = { invalid_fields: '请选择1至12个有效字段。', date_field_required: '设置日期区间时需要选择日期字段。', invalid_date_value: '所选日期字段含有无效日期，请核对字段和数据口径。', invalid_preview_date_range: '开始日期不能晚于结束日期。', data_asset_changed_retry: '数据版本已变化，请重新查询。', data_preview_unavailable: '数据暂时无法读取，请检查文件及数据读取环境。' };
  function setAsset() {
    generation += 1;
    const schema = schemas.find(item => item.assetId === form.elements.assetId.value);
    const columns = schema?.parquet?.fields || (schema?.columns || []).map(name => ({ name, type: 'CSV原始值' }));
    fields.replaceChildren(element('legend', '查询字段'));
    form.elements.dateField.replaceChildren(option('', '无日期筛选'));
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>字段</th><th>数据类型</th><th>允许空值</th></tr></thead>';
    const tbody = document.createElement('tbody');
    columns.forEach((column, index) => {
      const label = element('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.name = 'field'; checkbox.value = column.name; checkbox.checked = index < 8;
      label.append(checkbox, document.createTextNode(column.name));
      fields.append(label);
      form.elements.dateField.append(option(column.name, column.name));
      const row = document.createElement('tr');
      [column.name, column.type, column.nullable === undefined ? '未声明' : column.nullable ? '是' : '否'].forEach(value => row.append(element('td', value)));
      tbody.append(row);
    });
    if (columns.some(column => column.name === 'date')) form.elements.dateField.value = 'date';
    table.append(tbody);
    const details = document.createElement('details');
    details.append(element('summary', `完整字段字典 · ${columns.length} 个字段`), table);
    dictionary.replaceChildren(details);
    results.replaceChildren(); next.hidden = true; nextOffset = null; lastQuery = null; sourceVersion = null;
    form.querySelector('button').disabled = !columns.length;
  }
  async function queryData(params) {
    const current = ++generation;
    form.querySelector('button').disabled = true;
    next.disabled = true;
    results.replaceChildren(element('p', '查询中…'));
    try {
      const response = await fetch(`/api/modules/factors/v1/data-layer/preview?${params}`);
      const data = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw new Error(messages[data.error] || `数据查询失败：${data.error}`);
      sourceVersion = data.sourceVersion.fingerprint;
      lastQuery = new URLSearchParams(params);
      nextOffset = data.nextOffset;
      const summary = element('p', `返回 ${data.rowCount} 行 · 本批扫描 ${data.scannedRows} 行 · 位置 ${data.offset} · ${data.complete ? '已到文件末尾' : '仍有数据未扫描'}`);
      const version = element('p', `文件修改时间：${data.sourceVersion.updatedAt} · ${data.sourceVersion.bytes} 字节 · 数据快照：${data.snapshotIds.join(' / ') || '未绑定'}`);
      const missing = element('p', `样本缺失值：${Object.entries(data.missingCounts).map(([field, count]) => `${field} ${count}`).join(' / ')}`);
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      data.columns.forEach(column => tr.append(element('th', column)));
      thead.append(tr);
      const tbody = document.createElement('tbody');
      data.rows.forEach(row => {
        const tr = document.createElement('tr');
        data.columns.forEach(column => tr.append(element('td', row[column] === null ? '缺失' : String(row[column]))));
        tbody.append(tr);
      });
      table.append(thead, tbody);
      const scroll = element('div', null, 'preview-table-scroll');
      scroll.append(table);
      results.replaceChildren(summary, version, missing, scroll, ...data.notes.map(note => element('p', note)));
      if (!data.rowCount) results.append(element('p', data.complete ? '当前筛选条件没有匹配样本。' : '本批未找到匹配样本，可继续查询下一批。'));
      next.hidden = nextOffset === null;
    } catch (error) {
      if (current !== generation) return;
      results.replaceChildren(element('p', error.message, 'warning'));
      next.hidden = true;
    } finally {
      if (current === generation) { form.querySelector('button').disabled = false; next.disabled = false; }
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const selected = fields.querySelectorAll('input:checked');
    if (!selected.length || selected.length > 12) { results.replaceChildren(element('p', messages.invalid_fields, 'warning')); return; }
    const params = new URLSearchParams(new FormData(form));
    params.set('offset', '0');
    next.hidden = true;
    queryData(params);
  });
  next.addEventListener('click', () => {
    if (nextOffset === null || !lastQuery) return;
    const params = new URLSearchParams(lastQuery);
    params.set('offset', String(nextOffset));
    params.set('sourceVersion', sourceVersion);
    queryData(params);
  });
  form.elements.assetId.addEventListener('change', setAsset);
  setAsset();
  workspace.append(form, dictionary, results, next);
  return workspace;
}
async function dataQualityAuditPanel() {
  const response = await fetch('/api/modules/factors/v1/data-quality');
  if (!response.ok) throw new Error('数据质量审计暂不可用');
  const audit = await response.json();
  const panel = element('section', null, 'data-quality-audit');
  const head = element('section', null, 'quality-head');
  head.append(
    element('small', 'DATA QUALITY'),
    element('h2', '数据质量与口径审计'),
    element('p', '回测前先检查覆盖率修复、Schema可读性、换手成本敏感度和执行边界。这里只读旧导出日志和schema，不联网、不运行旧脚本。'),
  );
  const summary = element('section', null, 'quality-summary');
  for (const item of [
    ['原始失败', audit.coverage.raw.failureCount],
    ['修复后失败', audit.coverage.repair.failureCount],
    ['可读Schema', audit.schemaAudit.readableCount],
    ['高换手因子', audit.turnoverAudit.highSensitivityCount],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const grid = element('section', null, 'quality-grid');
  const coverage = element('article', null, 'quality-card');
  coverage.append(element('h3', '覆盖率修复状态'));
  for (const item of [
    ['原始采集', audit.coverage.raw],
    ['修复结果', audit.coverage.repair],
    ['报告导出', audit.coverage.report],
  ]) {
    const row = element('div', null, 'data-row');
    row.append(element('span', item[0]), element('b', item[1].status), element('small', item[1].summary));
    coverage.append(row);
  }
  const checks = element('article', null, 'quality-card');
  checks.append(element('h3', '回测前检查'));
  for (const item of audit.preBacktestChecks) {
    const row = element('div', null, 'data-row');
    row.append(element('span', item.title), element('b', item.status), element('small', item.notes));
    checks.append(row);
  }
  const turnover = element('article', null, 'quality-card wide-card');
  turnover.append(element('h3', '换手与成本敏感度'));
  const turnoverTable = document.createElement('table');
  turnoverTable.innerHTML = '<thead><tr><th>因子</th><th>年化换手</th><th>敏感度</th><th>说明</th></tr></thead>';
  const turnoverBody = document.createElement('tbody');
  for (const item of audit.turnoverAudit.items) {
    const tr = document.createElement('tr');
    for (const value of [item.factorKey, fmtPct(item.annualizedTurnover / 100), item.costSensitivity, item.notes]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    turnoverBody.append(tr);
  }
  turnoverTable.append(turnoverBody);
  turnover.append(turnoverTable);
  const issues = element('article', null, 'quality-card wide-card');
  issues.append(element('h3', '原始失败样本'));
  const issueTable = document.createElement('table');
  issueTable.innerHTML = '<thead><tr><th>来源</th><th>键</th><th>失败信息</th></tr></thead>';
  const issueBody = document.createElement('tbody');
  for (const item of audit.coverage.issues.slice(0, 12)) {
    const tr = document.createElement('tr');
    for (const value of [item.source, item.key, item.message]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    issueBody.append(tr);
  }
  issueTable.append(issueBody);
  issues.append(issueTable);
  const schema = element('article', null, 'quality-card wide-card');
  schema.append(element('h3', 'Schema审计'));
  const schemaTable = document.createElement('table');
  schemaTable.innerHTML = '<thead><tr><th>资产</th><th>状态</th><th>字段</th><th>形态</th></tr></thead>';
  const schemaBody = document.createElement('tbody');
  for (const item of audit.schemaAudit.items) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.status, item.fieldCount, item.rowShape || '-']) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    schemaBody.append(tr);
  }
  schemaTable.append(schemaBody);
  schema.append(schemaTable);
  grid.append(coverage, checks, turnover, issues, schema);
  const notes = element('section', null, 'product-notes');
  notes.append(element('h3', '审计边界'));
  for (const note of audit.notes) notes.append(element('p', note));
  panel.append(head, summary, grid, notes);
  return panel;
}
async function legacyExperimentLibraryPanel() {
  const response = await fetch('/api/modules/factors/v1/legacy-experiments');
  if (!response.ok) throw new Error('历史实验资产库暂不可用');
  const data = await response.json();
  const experiment = data.experiments[0];
  const panel = element('section', null, 'legacy-experiment-library');
  const head = element('section', null, 'legacy-head');
  head.append(
    element('small', 'LEGACY ASSET LIBRARY'),
    element('h2', '历史实验资产库'),
    element('p', '把旧因子实验室的实验参数、结果、归因、图表数据和导出文件标准化为只读资产包，作为新工作台迁移和视觉校准的参照。'),
  );
  const summary = element('section', null, 'legacy-summary');
  for (const item of [
    ['实验资产包', data.count],
    ['文件资产', data.assetCount],
    ['回测月份', experiment.parameterSet.months || '-'],
    ['迁移阶段', experiment.migrationPhase],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const grid = element('section', null, 'legacy-grid');
  const profile = element('article', null, 'legacy-card');
  profile.append(
    element('h3', experiment.title),
    element('p', `${experiment.legacyExperimentId} · ${experiment.status}`, 'next'),
    element('p', `周期：${(experiment.parameterSet.period || []).join(' ~ ') || '-'}；成本口径：${experiment.parameterSet.costMode || '-'}`),
  );
  const weights = element('div', null, 'factor-weight-list');
  for (const [key, value] of Object.entries(experiment.parameterSet.factorWeights || {})) {
    const row = element('span', null, 'pill');
    row.textContent = `${key} ${fmtPct(value, 1)}`;
    weights.append(row);
  }
  profile.append(element('h4', '旧实验权重'), weights);
  const metrics = element('article', null, 'legacy-card');
  metrics.append(element('h3', '结果摘要'));
  for (const item of [
    ['策略IRR', fmtPct(experiment.resultSummary.strategyIrr)],
    ['基准IRR', fmtPct(experiment.resultSummary.benchmarkIrr)],
    ['超额IRR', fmtPct(experiment.resultSummary.excessIrr)],
    ['最大回撤', fmtPct(experiment.resultSummary.maxDrawdown)],
    ['波动率', fmtPct(experiment.resultSummary.volatility)],
    ['Sharpe', fmtNum(experiment.resultSummary.sharpe)],
  ]) {
    const row = element('div', null, 'data-row');
    row.append(element('span', item[0]), element('b', item[1]));
    metrics.append(row);
  }
  const attribution = element('article', null, 'legacy-card wide-card');
  attribution.append(element('h3', '归因与因子诊断'));
  const attrTable = document.createElement('table');
  attrTable.innerHTML = '<thead><tr><th>因子</th><th>类型</th><th>权重</th><th>单因子超额</th><th>边际贡献</th><th>换手</th></tr></thead>';
  const attrBody = document.createElement('tbody');
  for (const item of experiment.attribution.factorDiagnostics) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.kind, fmtPct(item.configuredWeight, 1), fmtPct(item.soloExcess), fmtPct(item.marginalContribution), fmtPct(item.turnover)]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    attrBody.append(tr);
  }
  attrTable.append(attrBody);
  attribution.append(attrTable);
  const assets = element('article', null, 'legacy-card wide-card');
  assets.append(element('h3', '标准化文件资产'));
  const assetTable = document.createElement('table');
  assetTable.innerHTML = '<thead><tr><th>资产</th><th>文件</th><th>类型</th><th>大小</th><th>迁移状态</th></tr></thead>';
  const assetBody = document.createElement('tbody');
  for (const item of experiment.resultAssets) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.fileName, item.artifactType, fmtNum(item.bytes, 0), item.migrationStatus]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    assetBody.append(tr);
  }
  assetTable.append(assetBody);
  assets.append(assetTable);
  const mapping = element('article', null, 'legacy-card wide-card');
  mapping.append(element('h3', '迁移映射'));
  for (const item of experiment.standardizationMap) {
    const row = element('div', null, 'data-row');
    row.append(element('span', `${item.from} → ${item.to}`), element('b', item.status));
    mapping.append(row);
  }
  grid.append(profile, metrics, attribution, assets, mapping);
  const notes = element('section', null, 'product-notes');
  notes.append(element('h3', '迁移边界'));
  for (const note of data.notes) notes.append(element('p', note));
  for (const note of experiment.dataQuality.migrationWarnings) notes.append(element('p', note));
  panel.append(head, summary, grid, notes, await legacyArchivePanel());
  return panel;
}
async function legacyArchivePanel() {
  const panel = document.createElement('details'); panel.append(element('summary', '已归档实验版本与记录查询'));
  const response = await fetch('/api/modules/factors/v1/legacy-archives');
  if (!response.ok) { panel.append(element('p', '历史归档接口尚未就绪，请重启工作台服务。', 'warning')); return panel; }
  const list = await response.json();
  if (list.errors?.length) panel.append(element('p', `${list.errors.length}个归档清单损坏，已隔离；请独立核验原始副本。`, 'warning'));
  if (!list.items?.length) { panel.append(element('p', '尚未建立历史导出归档。', 'next')); return panel; }
  const version = document.createElement('select'); version.setAttribute('aria-label', '历史归档版本');
  list.items.forEach(item => version.append(option(item.archiveId, `${item.createdAt} · ${item.recordCount}条 · ${item.archiveId.slice(0, 12)}`)));
  const category = document.createElement('select'); category.setAttribute('aria-label', '历史记录类型');
  category.append(option('', '全部类型'));
  [...new Set(list.items.flatMap(item => item.categories))].forEach(value => category.append(option(value, value)));
  const search = document.createElement('input'); search.type = 'search'; search.maxLength = 100; search.setAttribute('aria-label', '历史实验查询');
  const form = document.createElement('form'), submit = element('button', '查询'); submit.type = 'submit';
  const previous = element('button', '上一页'), next = element('button', '下一页'); previous.type = next.type = 'button';
  const status = element('p'), results = element('div');
  let offset = 0, generation = 0, appliedQuery = '';
  async function load() {
    const current = ++generation, selected = version.value;
    previous.disabled = next.disabled = true; status.textContent = '读取归档记录…';
    try {
      const params = new URLSearchParams({ q: appliedQuery, category: category.value, offset: String(offset), limit: '20' });
      const response = await fetch(`/api/modules/factors/v1/legacy-archives/${selected}?${params}`);
      const data = await response.json(); if (current !== generation) return;
      if (!response.ok) throw new Error(data.error || '历史记录读取失败');
      status.textContent = `${data.total}条记录 · ${data.assets.length}份原始资产 · 清单身份已核验，文件完整性须独立核验`;
      results.replaceChildren();
      for (const row of data.items) {
        const detail = document.createElement('details');
        detail.append(element('summary', `${row.title} · ${row.category}`), element('p', `${row.sourcePath}#${row.jsonPointer} · ${row.sourceSha256}`),
          element('p', `参数完整性：${row.parameterCompleteness}；仅旧结果归档，未重新计算。`),
          element('p', `恢复状态：${row.status}；静态表单属性不代表历史实验实际取值，JavaScript动态状态不推断。`),
          element('pre', JSON.stringify({ parameters: row.parameters, period: row.period, summary: row.summary, curve: row.curve, literal: row.literal }, null, 2)));
        results.append(detail);
      }
      data.limitations.forEach(note => results.append(element('p', note, 'next')));
      previous.disabled = offset === 0; next.disabled = !data.hasMore;
    } catch (error) { if (current === generation) { results.replaceChildren(); status.textContent = error.message; } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); offset = 0; appliedQuery = search.value; load(); });
  version.addEventListener('change', () => { offset = 0; load(); }); category.addEventListener('change', () => { offset = 0; load(); });
  previous.addEventListener('click', () => { if (!previous.disabled) { offset = Math.max(0, offset-20); load(); } });
  next.addEventListener('click', () => { if (!next.disabled) { offset += 20; load(); } });
  form.append(version, category, search, submit); panel.append(form, status, previous, next, results); await load(); return panel;
}

async function legacyDcaReplayPanel() {
  const panel=element('section',null,'strategy-config-workbench');panel.id='legacy-dca-replay';panel.append(element('h2','510300 归档定投与PE择时'));
  panel.append(element('p','归档假设复算 · not_point_in_time_verified · 当日VWAP/复权份额并非真实成交，观测日滞后不证明历史披露可得时间。','warning'));
  const form=document.createElement('form'), box=document.createElement('fieldset'), message=element('p','','form-message'), result=element('section');message.setAttribute('role','status');
  box.className='strategy-grid-form';form.append(box,message);panel.append(form,result);
  const inputs={};
  function field(key,label,type='number') {const wrapper=element('label',label),input=document.createElement(type==='select'?'select':'input');input.name=key;if(type!=='select')input.type=type;input.required=!['checkbox','file'].includes(type);wrapper.append(input);box.append(wrapper);inputs[key]=input;return input;}
  field('archiveId','原件归档版本','select');
  for(const [key,label,type] of [['amount','每期基准投入（元）'],['fee','佣金比例'],['slippage','滑点比例'],['nth','月内买入日','select'],['startMonth','开始月份','month'],['endMonth','结束月份','month'],['peKey','PE口径','select'],['years','回看年数'],['mode','投入方式','select'],['cashRate','现金年利率'],['timingEnabled','启用PE择时','checkbox']])field(key,label,type);
  for(const n of [1,2,3,5,10,15,-1])inputs.nth.append(option(String(n),n===-1?'每月最后交易日':`每月第${n}个交易日`));
  for(const [key,title] of [['TTM','滚动整体PE'],['LYR','静态整体PE'],['MED','成分股PE中位数']])inputs.peKey.append(option(key,title));
  inputs.mode.append(option('pool','同额承诺现金池'),option('free','实际倍数投入（不同现金流）'));
  for(const key of ['fee','slippage','cashRate']){inputs[key].min='0';inputs[key].step='.0001';inputs[key].max=key==='cashRate'?'.2':'.1';}
  inputs.amount.min='100';inputs.amount.max='100000000';inputs.years.min='1';inputs.years.max='20';inputs.years.step='1';
  const ladder=element('section');ladder.append(element('h3','分位档位与投入倍数'));box.append(ladder);let ladderInputs=[];
  const run=element('button','复算归档数据');run.type='submit';box.append(run);
  const reset=element('button','恢复归档默认参数');reset.type='button';box.append(reset);
  const download=element('button','下载参数 JSON');download.type='button';box.append(download);
  const upload=field('parameterFile','参数文件','file');upload.accept='.json,application/json';
  let source=null,defaults=null,generation=0,busy=false;
  function fill(p) {
    for(const key of Object.keys(inputs).filter(key=>!['archiveId','parameterFile'].includes(key))) {if(key==='timingEnabled')inputs[key].checked=p[key];else inputs[key].value=p[key];}
    ladder.replaceChildren(element('h3','分位档位与投入倍数'));ladderInputs=[];
    for(const bucket of p.ladder){const row=element('label','分位上界（%）'),hi=document.createElement('input'),multiple=document.createElement('input');hi.type=multiple.type='number';hi.min='0';hi.max='100';hi.step='1';hi.value=bucket.hi;multiple.min='0';multiple.max='10';multiple.step='.05';multiple.value=bucket.multiple;hi.setAttribute('aria-label',`分位上界 ${bucket.hi}`);multiple.setAttribute('aria-label',`分位 ${bucket.hi} 投入倍数`);row.append(hi,element('span','投入倍数'),multiple);ladder.append(row);ladderInputs.push({hi,multiple});}
    result.replaceChildren();message.textContent='';
  }
  function parameters(){return Object.fromEntries(Object.keys(defaults).map(key=>[key,key==='ladder'?ladderInputs.map(x=>({hi:Number(x.hi.value),multiple:Number(x.multiple.value)})):key==='timingEnabled'?inputs[key].checked:['startMonth','endMonth','peKey','mode'].includes(key)?inputs[key].value:Number(inputs[key].value)]));}
  async function load(id='') {
    const token=++generation;busy=true;box.disabled=true;result.replaceChildren();
    try {
      const response=await fetch('/api/modules/factors/v1/legacy-dca/options'+(id?'?'+new URLSearchParams({archiveId:id}):'')),data=await response.json();
      if(token!==generation)return;if(!response.ok)throw new Error(data.error || '归档行情不可用');
      source=data.sourceVersion;defaults=data.defaults;inputs.archiveId.replaceChildren();data.archives.forEach(a=>inputs.archiveId.append(option(a.archiveId,`${a.createdAt} · ${a.archiveId.slice(0,12)}`)));inputs.archiveId.value=source.archiveId;fill(defaults);
      message.textContent=`510300 · ${data.pricePeriod.join(' → ')} · ${data.priceObservations}行情观测 / ${data.peObservations}估值观测 · ${source.sha256}`;
    } catch(error){if(token===generation){source=null;message.textContent=error.message;}}
    finally{if(token===generation){busy=false;box.disabled=false;run.disabled=!source;}}
  }
  inputs.archiveId.addEventListener('change',()=>load(inputs.archiveId.value));
  form.addEventListener('change',event=>{if(event.target!==inputs.archiveId&&event.target!==upload){generation++;result.replaceChildren();}});
  reset.addEventListener('click',()=>{if(!busy&&defaults){generation++;fill(defaults);}});
  download.addEventListener('click',()=>{if(source&&!busy)downloadFactorFile(JSON.stringify({archiveId:source.archiveId,sourceSha256:source.sha256,parameters:parameters()},null,2),'application/json','510300-replay-parameters.json');});
  upload.addEventListener('change',async()=>{
    const file=upload.files?.[0];if(!file||busy)return;const token=++generation;box.disabled=true;busy=true;
    try{if(file.size>65536)throw new Error('参数文件超过64KiB');const data=JSON.parse(await file.text());if(token!==generation)return;if(data.archiveId!==source?.archiveId||data.sourceSha256!==source?.sha256)throw new Error('参数文件不属于当前归档版本');const p=data.parameters;if(!p||Object.keys(p).sort().join('|')!==Object.keys(defaults).sort().join('|')||typeof p.timingEnabled!=='boolean'||!['pool','free'].includes(p.mode)||!['TTM','LYR','MED'].includes(p.peKey)||!['amount','fee','slippage','nth','years','cashRate'].every(key=>Number.isFinite(p[key]))||!['startMonth','endMonth'].every(key=>typeof p[key]==='string'&&/^\d{4}-\d{2}$/.test(p[key]))||!Array.isArray(p.ladder)||!p.ladder.length||p.ladder.length>12||p.ladder.some(row=>!row||!Number.isFinite(row.hi)||!Number.isFinite(row.multiple)))throw new Error('参数文件结构或类型不完整');fill(p);message.textContent='参数已载入，尚未复算；数值与档位由后端校验。';}
    catch(error){if(token===generation)message.textContent=error.message;}finally{if(token===generation){busy=false;box.disabled=false;}}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!source)return;const token=++generation,p=parameters();busy=true;box.disabled=true;result.replaceChildren();
    try{
      const response=await fetch('/api/modules/factors/v1/legacy-dca/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({archiveId:source.archiveId,sourceSha256:source.sha256,parameters:p})}),data=await response.json();
      if(token!==generation)return;if(!response.ok)throw new Error(data.error || '复算失败');
      message.textContent=p.mode==='pool'?'已复算：同额承诺现金流；未写配置、请求或结果库。':'已复算：不同实际现金流，终值不可排名；XIRR分别计算，未写配置、请求或结果库。';
      result.append(resultDiagnosticTable('全期账户指标',['指标','PE策略','固定定投'],[['终值',money(data.metrics.finalValue),money(data.metrics.benchmarkFinalValue)],['累计实际投入',money(data.metrics.totalContributed),money(data.metrics.benchmarkContributed)],['实际日期XIRR',fmtPct(data.metrics.moneyWeightedIrr),fmtPct(data.metrics.benchmarkMoneyWeightedIrr)]]));
      const mode=document.createElement('select');mode.setAttribute('aria-label','510300复算图表');for(const [key,title]of [['value','账户价值'],['nav','单位净值'],['profit','累计简单收益'],['drawdown','历史高点回撤'],['pe','PE分位'],['excess','择时净值差'],['price','复权价格与均线']])mode.append(option(key,title));
      const chart=element('section');const draw=()=>{
        const ledger=data.accountLedger;let series,items,markers=[];
        if(['profit','drawdown'].includes(mode.value)){series=accountModeSeries(ledger,mode.value);items=[{key:'strategy',name:'PE策略',color:'#a62536'},{key:'benchmark',name:'固定定投',color:'#24764c'}];}
        else {const keys=mode.value==='value'?['accountValue','benchmarkValue','cash']:mode.value==='nav'?['unitNav','benchmarkNav','lumpBenchmarkNav']:mode.value==='pe'?['pePercentile']:mode.value==='excess'?['timingExcessNav']:['adjustedClose','ma20','ma60','ma200'];series=Object.fromEntries(keys.map(key=>[key,ledger.map(row=>({date:row.date,value:row[key]}))]));const labels={accountValue:'PE账户',benchmarkValue:'固定定投账户',cash:'闲置现金',unitNav:'PE净值',benchmarkNav:'定投净值',lumpBenchmarkNav:'首日一次性买入净值',pePercentile:'前观测日PE分位',timingExcessNav:'PE净值减定投净值（非IRR差）',adjustedClose:'复权收盘',ma20:'MA20',ma60:'MA60',ma200:'MA200'};items=keys.map((key,i)=>({key,name:labels[key],color:['#a62536','#24764c','#2764a5','#777'][i]}));if(mode.value==='price'){const prices=new Map(ledger.map(row=>[row.date,row.adjustedClose]));markers=data.trades.map(row=>({date:row.date,value:prices.get(row.date),status:row.status,label:`${row.multiple}倍 / ${money(row.spend)}元`}));}}
        chart.replaceChildren(element('p',items.map(x=>x.name).join(' / '),'next'),chartWorkspace(series,{items,markers,label:`510300 ${mode.selectedOptions[0].textContent}`}));};mode.addEventListener('change',draw);result.append(mode,chart);draw();
      const trades=factorRecordBrowser('510300交易记录',row=>resultDiagnosticTable(row.date,['状态','信号观测日','PE','分位','倍数','投入','买入','现金'],[[row.status,row.signalDate,fmtNum(row.pe),fmtPct(row.percentile),row.multiple,money(row.deposit),money(row.spend),money(row.cash)]]));trades.setItems(data.trades.map(row=>({...row,title:row.date})));result.append(trades.node);
      const metadata={archiveId:data.sourceVersion.archiveId,sourceSha256:data.sourceVersion.sha256,calculationSources:data.calculationSources,version:data.version,parameters:data.parameters,temporalEligibility:data.temporalEligibility.status};
      const tradeRows=data.trades.map(row=>({...metadata,...row})),ledgerRows=data.accountLedger.map(row=>({...metadata,...row}));
      const exports=element('div');
      for(const [title,extension,content] of [
        ['下载复算结果 JSON','json',JSON.stringify(data,null,2)],
        ['下载交易记录 CSV','trades.csv',csvText(tradeRows,[...new Set(tradeRows.flatMap(Object.keys))])],
        ['下载序列 CSV','series.csv',csvText(ledgerRows,[...new Set(ledgerRows.flatMap(Object.keys))])],
      ]) {
        const button=element('button',title);button.type='button';
        button.addEventListener('click',()=>downloadFactorFile(content,extension==='json'?'application/json':'text/csv;charset=utf-8',`510300-${data.sourceVersion.archiveId.slice(0,12)}.${extension}`));exports.append(button);
      }
      result.append(exports,element('p',`${data.temporalEligibility.status} · 当日VWAP与复权份额为归档模拟；MA为全行情历史移动均值，买入/停投标记来自本次实际计划。无约束模式按实际倍数投入，不保留旧负现金借贷口径。净值按投入前未滑点复权VWAP单位化，非昨日账户价值加存款近似。`,'warning'));
    }catch(error){if(token===generation)message.textContent=error.message;}finally{if(token===generation){busy=false;box.disabled=false;}}
  });
  await load();return panel;
}

async function customExpressionPanel() {
  const panel = element('section', null, 'strategy-config-workbench');
  panel.id = 'custom-expression';
  panel.append(element('h2', '可执行因子与行业策略'));
  async function api(url, body, method = 'POST') {
    const response = await fetch(url, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.errors?.join('；') || data.error || '读取失败');
    return data;
  }
  let options, configs;
  try {
    options = await api('/api/modules/factors/v1/custom-expression/options');
    configs = await api('/api/modules/factors/v1/experiment-configs');
  } catch (error) { panel.append(element('p', error.message, 'warning')); return panel; }
  const template = configs.templates.find(t => t.strategyTemplateId === 'strategy.custom_industry_expression');
  const copy = value => JSON.parse(JSON.stringify(value));
  function editor(title) {
    const form = document.createElement('form'), box = document.createElement('fieldset');
    box.append(element('legend', title)); form.append(box); panel.append(form);
    const message = element('p', '', 'form-message'); message.setAttribute('role', 'status'); form.append(message);
    return { form, box, message, busy: false };
  }
  function field(parent, name, label, tag = 'input', type = 'text') {
    const wrapper = element('label', label), input = document.createElement(tag);
    input.name = name; if (tag === 'input') input.type = type;
    wrapper.append(input); parent.append(wrapper); return input;
  }
  function button(parent, title, action, type = 'button') {
    const input = element('button', title); input.type = type; if (action) input.addEventListener('click', action); parent.append(input); return input;
  }
  async function locked(state, action) {
    if (state.busy) return;
    state.busy = true; state.box.disabled = true; state.message.textContent = '';
    try { await action(); } catch (error) { state.message.textContent = error.message; }
    finally { state.busy = false; state.box.disabled = false; }
  }
  const definition = editor('因子定义'), d = {};
  d.saved = field(definition.box, 'savedFactor', '已入库定义', 'select');
  d.id = field(definition.box, 'factorFamilyId', '因子ID');
  d.title = field(definition.box, 'factorTitle', '因子名称');
  d.usage = field(definition.box, 'usageLogic', '实验使用边界', 'textarea');
  d.notes = field(definition.box, 'researchNotes', '研究依据与备注', 'textarea');
  const bindingsBox = element('section'); bindingsBox.append(element('h3', '数据字段绑定')); definition.box.append(bindingsBox);
  const nodesBox = element('section'); nodesBox.append(element('h3', '子因子与中间指标')); definition.box.append(nodesBox);
  let bindings = [], nodes = [], editingFactor = null, definitionBase = {};
  function bindingRow(alias = '', source = 'close') {
    const row = element('div', null, 'subfactor-row');
    const key = field(row, 'bindingAlias', '变量名'), value = field(row, 'bindingSource', '来源字段', 'select'); key.value = alias;
    for (const item of options.fields) value.append(option(item.field, `${item.field} · ${item.name} · ${item.definition || item.unit || ''}`));
    value.value = source;
    const entry = { row, key, value }; bindings.push(entry); bindingsBox.append(row);
    button(row, '移除字段', () => { if (!definition.busy) { bindings = bindings.filter(x => x !== entry); row.remove(); } });
  }
  function nodeRow(item = {}) {
    const row = element('div', null, 'subfactor-row');
    const id = field(row, 'nodeId', '指标ID'), expression = field(row, 'nodeExpression', '计算表达式'), meaning = field(row, 'nodeDefinition', '指标定义', 'textarea');
    const direction = field(row, 'nodeDirection', '排序方向', 'select'), weight = field(row, 'nodeWeight', '相对权重（0为中间指标）', 'input', 'number');
    direction.append(option('higher_is_better', '高值优先'), option('lower_is_better', '低值优先'));
    id.value = item.id || ''; expression.value = item.expression || ''; meaning.value = item.definition || ''; direction.value = item.direction || 'higher_is_better';
    weight.min = '0'; weight.max = '100'; weight.step = '0.01'; weight.value = item.weight ?? 1;
    const entry = { row, id, expression, meaning, direction, weight }; nodes.push(entry); nodesBox.append(row);
    button(row, '移除指标', () => { if (!definition.busy) { nodes = nodes.filter(x => x !== entry); row.remove(); } });
  }
  button(definition.box, '新增字段', () => { if (!definition.busy && bindings.length < 16) bindingRow(); });
  button(definition.box, '新增指标', () => { if (!definition.busy && nodes.length < 16) nodeRow(); });
  const validation = element('div'); definition.box.append(validation);
  function spec() {
    const pairs = bindings.map(x => [x.key.value.trim(), x.value.value]);
    if (new Set(pairs.map(x => x[0])).size !== pairs.length) throw new Error('字段变量名不能重复。');
    return { dialect: 'industry_expression_v1', bindings: Object.fromEntries(pairs), nodes: nodes.map(x => ({ id: x.id.value.trim(), expression: x.expression.value.trim(), definition: x.meaning.value.trim(), direction: x.direction.value, weight: Number(x.weight.value) })), missingValuePolicy: 'complete_case', normalization: 'cross_section_zscore_clip_3' };
  }
  function showValidation(result) {
    validation.replaceChildren(element('p', `公式版本 ${result.executionSha256}`), resultDiagnosticTable('依赖与执行顺序', ['指标', '依赖'], result.evaluationOrder.map(id => [id, result.dependencies[id].join(' / ') || '常数'])));
  }
  const programKey = value => JSON.stringify([value.factorFamilyId, value.revision, value.executionSha256]);
  const availablePrograms = new Map();
  function familyChoices() {
    d.saved.replaceChildren(option('', '新定义'));
    c.family.replaceChildren(option('', '未绑定'));
    availablePrograms.clear();
    for (const item of options.families) {
      availablePrograms.set(programKey(item.program), copy(item.program));
      d.saved.append(option(item.factorFamilyId, `${item.title} · r${item.program.revision}`));
      c.family.append(option(programKey(item.program), `${item.title} · r${item.program.revision}`));
    }
    d.saved.value = editingFactor || '';
    if (program) {
      availablePrograms.set(programKey(program), copy(program));
      if (!options.families.some(x => programKey(x.program) === programKey(program))) c.family.append(option(programKey(program), `${program.factorFamilyId} · 已绑定历史版本 r${program.revision}`));
      c.family.value = programKey(program);
    }
  }
  function fillDefinition(item = {}) {
    editingFactor = item.factorFamilyId || null; definitionBase = copy(item);
    const existing = new Set(options.families.map(x => x.factorFamilyId)); let i = 1;
    while (existing.has(`library.custom.expression_${i}`)) i += 1;
    d.id.value = editingFactor || `library.custom.expression_${i}`; d.title.value = item.title || '自研行业复合因子';
    d.usage.value = item.usageLogic || '行业横截面排序；行业指数代理，不等同真实ETF执行或历史成分PIT回测。'; d.notes.value = item.researchNotes || '';
    const value = item.executionSpec || options.defaultSpec;
    for (const entry of [...bindings, ...nodes]) entry.row.remove(); bindings = []; nodes = [];
    for (const [alias, source] of Object.entries(value.bindings)) bindingRow(alias, source);
    value.nodes.forEach(nodeRow); validation.replaceChildren(); definition.message.textContent = ''; d.saved.value = editingFactor || '';
  }
  button(definition.box, '校验公式', () => locked(definition, async () => showValidation(await api('/api/modules/factors/v1/custom-expression/validate', { executionSpec: spec() }))));
  button(definition.box, '新建定义', () => { if (!definition.busy) fillDefinition(); });
  button(definition.box, '保存可执行定义', null, 'submit');
  editExpressionFactor = item => locked(definition, async () => {
    const result = await api(`/api/modules/factors/v1/library/submissions/${encodeURIComponent(item.factorFamilyId)}`);
    fillDefinition(result.item); panel.scrollIntoView({ block: 'start' });
  });
  d.saved.addEventListener('change', () => d.saved.value ? editExpressionFactor({ factorFamilyId: d.saved.value }) : (!definition.busy && fillDefinition()));
  definition.form.addEventListener('submit', event => {
    event.preventDefault(); return locked(definition, async () => {
      const executionSpec = spec(), id = d.id.value.trim(), method = industrySaveMethod(editingFactor, id);
      const payload = { ...definitionBase, factorFamilyId: id, title: d.title.value.trim(), category: 'custom', universe: 'sw_industry_and_etf_proxy', frequency: 'daily_panel_monthly_rebalance',
        version: 'user-executable-v1', sourceAssetIds: ['factors.etf_smartbeta.panel'], snapshotIds: ['snapshot.etf_smartbeta.industry_execution.current'],
        calculationLogic: executionSpec.nodes.map(n => `${n.id} = ${n.expression}; direction=${n.direction}; weight=${n.weight}`).join('\n'), usageLogic: d.usage.value.trim(), researchNotes: d.notes.value.trim(), executionSpec,
        fields: executionSpec.nodes.map(n => ({ field: n.id, name: n.id, role: 'sub_factor', formula: n.expression, definition: n.definition, direction: n.direction, missingValuePolicy: 'complete_case', usageLogic: d.usage.value.trim() })) };
      const result = await api(method === 'PUT' ? `/api/modules/factors/v1/library/submissions/${encodeURIComponent(id)}` : '/api/modules/factors/v1/library/submissions', payload, method);
      editingFactor = result.item.factorFamilyId; definitionBase = copy(result.item);
      options = await api('/api/modules/factors/v1/custom-expression/options'); familyChoices();
      definition.message.textContent = `已入库 ${editingFactor} · r${result.item.revision}`;
    });
  });
  const strategy = editor('自建因子策略配置'), c = {}; let program = null, editingConfig = null;
  for (const [name, label, tag, type] of [
    ['savedConfig', '已保存配置', 'select'], ['configId', '配置ID'], ['title', '策略名称'], ['snapshotId', '数据版本', 'select'], ['family', '可执行因子', 'select'],
    ['startDate', '开始日期', 'input', 'date'], ['endDate', '结束日期', 'input', 'date'], ['topN', 'Top N', 'input', 'number'], ['minInvestable', '最少合格行业', 'input', 'number'], ['signalLagDays', '信号滞后数据日', 'input', 'number'],
    ['commission', '单边佣金', 'input', 'number'], ['slippage', '单边滑点', 'input', 'number'], ['annual_fee', '行业年费率', 'input', 'number'], ['notes', '备注', 'textarea']]) c[name] = field(strategy.box, name, label, tag, type);
  for (const key of ['commission', 'slippage', 'annual_fee']) { c[key].min = '0'; c[key].max = '0.1'; c[key].step = '0.00001'; }
  for (const key of ['topN', 'minInvestable', 'signalLagDays']) { c[key].min = '1'; c[key].max = key === 'minInvestable' ? '31' : '20'; c[key].step = '1'; }
  const bindingSummary = element('p'), preview = element('div'); strategy.box.append(bindingSummary, preview);
  function showBinding() { bindingSummary.textContent = program ? `绑定 ${program.factorFamilyId} · r${program.revision} · ${program.executionSha256}` : '未绑定公式版本'; preview.replaceChildren(); }
  c.family.addEventListener('change', () => { if (!strategy.busy) { program = copy(availablePrograms.get(c.family.value) || null); showBinding(); } });
  function fillConfig(item = template) {
    editingConfig = item.configId || null; let i = 1;
    while (configs.items.some(x => x.configId === `config.custom_expression_${i}`)) i += 1;
    c.configId.value = editingConfig || `config.custom_expression_${i}`; c.title.value = item.title;
    const snapshot = item.snapshotId || template.snapshotId;
    if (![...c.snapshotId.options].some(x => x.value === snapshot)) c.snapshotId.append(option(snapshot, snapshot)); c.snapshotId.value = snapshot;
    for (const key of ['startDate', 'endDate', 'topN', 'minInvestable', 'signalLagDays']) c[key].value = item.strategySettings[key];
    const costs = Object.fromEntries(item.costModel.split(';').map(x => x.split('=')));
    for (const key of ['commission', 'slippage', 'annual_fee']) c[key].value = costs[key]; c.notes.value = item.notes || '';
    program = copy(item.strategySettings.factorProgram || null); familyChoices(); showBinding();
    c.savedConfig.replaceChildren(option('', '新配置'));
    configs.items.filter(x => x.strategyTemplateId === template.strategyTemplateId).forEach(x => c.savedConfig.append(option(x.configId, `${x.title} · r${x.revision}`)));
    c.savedConfig.value = editingConfig || ''; strategy.message.textContent = '';
  }
  function configPayload() {
    if (!program) throw new Error('需要先绑定已入库的可执行因子。');
    return { ...template, configId: c.configId.value.trim(), title: c.title.value.trim(), snapshotId: c.snapshotId.value, notes: c.notes.value.trim(),
      factorFamilyIds: [program.factorFamilyId], factorWeights: [{ factorFamilyId: program.factorFamilyId, weight: 1 }],
      costModel: ['commission', 'slippage', 'annual_fee'].map(key => `${key}=${c[key].value}`).join(';'),
      strategySettings: { ...template.strategySettings, ...Object.fromEntries(['startDate', 'endDate'].map(key => [key, c[key].value])),
        ...Object.fromEntries(['topN', 'minInvestable', 'signalLagDays'].map(key => [key, Number(c[key].value)])), factorProgram: copy(program) } };
  }
  editExpressionConfig = item => locked(strategy, async () => {
    configs = await api('/api/modules/factors/v1/experiment-configs');
    const current = item.configId ? configs.items.find(x => x.configId === item.configId) : template;
    if (!current) throw new Error('该配置已不存在。'); fillConfig(current); panel.scrollIntoView({ block: 'start' });
  });
  c.savedConfig.addEventListener('change', () => editExpressionConfig({ configId: c.savedConfig.value }));
  button(strategy.box, '新建公式策略', () => { if (!strategy.busy) fillConfig(); });
  button(strategy.box, '试算因子定位', () => locked(strategy, async () => {
    const result = await api('/api/modules/factors/v1/custom-expression/preview', { config: configPayload() });
    preview.replaceChildren(element('h3', `${result.previewDate} · 同日横截面试算（非执行信号）`),
      resultDiagnosticTable('行业排序与贡献', ['行业', '得分', '子因子贡献'], result.ranked.map(x => [x.code, fmtNum(x.score), x.factorDetails.map(n => `${n.field}: ${fmtNum(n.contribution)}`).join(' / ')])));
    strategy.message.textContent = '试算未保存为回测结果。';
  }));
  button(strategy.box, '保存公式策略配置', null, 'submit');
  strategy.form.addEventListener('submit', event => {
    event.preventDefault(); return locked(strategy, async () => {
      const payload = configPayload(), method = industrySaveMethod(editingConfig, payload.configId);
      const result = await api(method === 'PUT' ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(payload.configId)}` : '/api/modules/factors/v1/experiment-configs', payload, method);
      editingConfig = result.item.configId; configs = await api('/api/modules/factors/v1/experiment-configs');
      fillConfig(result.item); strategy.message.textContent = `已保存 ${editingConfig} · r${result.item.revision}`;
      if (refreshFactorExecution) await refreshFactorExecution();
    });
  });
  await populateSnapshotSelect(c.snapshotId, template.snapshotId);
  familyChoices(); fillDefinition(); fillConfig();
  return panel;
}

async function customFactorStudioPanel(library) {
  const panel = element('section', null, 'custom-factor-studio');
  const head = element('section', null, 'studio-head');
  head.append(
    element('small', 'CUSTOM FACTOR STUDIO'),
    element('h2', '自建因子策略编辑器'),
    element('p', '把新的研究想法先写成可版本化的因子定义：公式、子因子、方向、缺失值、适用快照和使用边界都必须明确，然后再进入实验配置和回测。'),
  );
  const ingredients = library.items.flatMap(item => item.fields.slice(0, 4).map(field => ({
    family: item.factorFamilyId,
    title: item.title,
    field: field.field,
    name: field.name,
    direction: field.direction,
  }))).slice(0, 18);
  const form = document.createElement('form');
  form.className = 'studio-form';
  form.innerHTML = `
    <div class="strategy-grid-form">
      <label>因子ID<input name="factorFamilyId" value="library.custom.research_factor_v1"></label>
      <label>标题<input name="title" value="自研复合因子V1"></label>
      <label>适用范围<select name="universe"></select></label>
      <label>类别<input name="category" value="custom"></label>
      <label>频率<select name="frequency"></select></label>
      <label>适用快照<select name="snapshotIds"></select></label>
    </div>
    <label>复合计算逻辑<textarea name="calculationLogic">score = 0.30*z(value) + 0.25*z(momentum) + 0.20*z(low_volatility) + 0.15*z(dividend) - 0.10*z(crowding)</textarea></label>
    <label>实验使用逻辑<textarea name="usageLogic">用于横截面排序和配置强度解释；不得跨不同snapshot、不同benchmark或不同成本模型直接比较。</textarea></label>
    <section class="ingredient-bank"><h3>可用指标素材</h3></section>
    <section class="subfactor-editor"><h3>子因子结构</h3><div class="subfactor-rows"></div><button type="button" name="addSubfactor">新增子因子</button></section>
    <section class="studio-preview" aria-live="polite"></section>
    <button type="submit">保存为因子库定义</button><p class="form-message" role="status"></p>
  `;
  form.elements.universe.append(option('sw_industry_and_etf_proxy', '行业/ETF代理'), option('public_funds', '公募基金'), option('broad_index', '宽基指数'));
  form.elements.frequency.append(option('monthly', '月度'), option('quarterly', '季度'), option('daily_panel_monthly_rebalance', '日频面板/月度调仓'));
  form.elements.snapshotIds.append(option('snapshot.etf_smartbeta.industry_panel.current', '行业面板'), option('snapshot.fund_warehouse.wide_today.current', '基金宽表'), option('snapshot.etf_smartbeta.broad_panel.current', '宽基面板'));
  const bank = form.querySelector('.ingredient-bank');
  for (const item of ingredients) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ingredient-chip';
    chip.textContent = `${item.name || item.field}`;
    chip.title = `${item.title} · ${item.direction}`;
    chip.addEventListener('click', () => addSubfactor(item));
    bank.append(chip);
  }
  const rows = form.querySelector('.subfactor-rows');
  function subfactorRow(item = {}) {
    const row = element('div', null, 'subfactor-row');
    row.innerHTML = `
      <input name="field" placeholder="field" value="${item.field || ''}">
      <input name="name" placeholder="指标名称" value="${item.name || ''}">
      <select name="role"><option value="sub_factor">子因子</option><option value="risk_metric">风险指标</option><option value="filter">过滤条件</option></select>
      <select name="direction"><option value="higher_is_better">越高越好</option><option value="lower_is_better">越低越好</option><option value="neutral">中性</option></select>
      <input name="formula" placeholder="公式/来源字段" value="${item.formula || item.field || ''}">
      <input name="missingValuePolicy" placeholder="缺失值策略" value="missing excluded and flagged">
      <button type="button">移除</button>
    `;
    row.querySelector('[name=direction]').value = item.direction || 'higher_is_better';
    row.querySelector('button').addEventListener('click', () => { row.remove(); updatePreview(); });
    row.addEventListener('input', updatePreview);
    rows.append(row);
    updatePreview();
  }
  function addSubfactor(item = {}) {
    subfactorRow({
      field: item.field || '',
      name: item.name || '',
      direction: item.direction || 'higher_is_better',
      formula: item.field || '',
    });
  }
  function collectSubfactors() {
    return [...rows.querySelectorAll('.subfactor-row')].map(row => ({
      field: row.querySelector('[name=field]').value.trim(),
      name: row.querySelector('[name=name]').value.trim(),
      role: row.querySelector('[name=role]').value,
      formula: row.querySelector('[name=formula]').value.trim(),
      direction: row.querySelector('[name=direction]').value,
      missingValuePolicy: row.querySelector('[name=missingValuePolicy]').value.trim(),
      definition: '由自建因子编辑器保存。',
      usageLogic: '作为复合因子的可追踪输入字段。',
    })).filter(item => item.field || item.name);
  }
  function updatePreview() {
    const fields = collectSubfactors();
    form.querySelector('.studio-preview').replaceChildren(
      element('h3', '保存预览'),
      element('p', `${fields.length} 个子因子 · ${form.elements.universe.selectedOptions[0].textContent} · ${form.elements.snapshotIds.value}`),
      element('p', form.elements.calculationLogic.value, 'next'),
    );
  }
  for (const name of ['calculationLogic', 'universe', 'snapshotIds']) form.elements[name].addEventListener('input', updatePreview);
  form.elements.addSubfactor.addEventListener('click', () => addSubfactor());
  addSubfactor({ field: 'value_score', name: '价值分', direction: 'higher_is_better', formula: 'z(BM) + z(EP)' });
  addSubfactor({ field: 'crowding_penalty', name: '拥挤惩罚', direction: 'lower_is_better', formula: 'z(turnover_pct) + z(valuation_expansion)' });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const payload = {
      factorFamilyId: formValue(form, 'factorFamilyId'),
      title: formValue(form, 'title'),
      universe: formValue(form, 'universe'),
      category: formValue(form, 'category'),
      frequency: formValue(form, 'frequency'),
      snapshotIds: [formValue(form, 'snapshotIds')],
      calculationLogic: formValue(form, 'calculationLogic'),
      usageLogic: formValue(form, 'usageLogic'),
      fields: collectSubfactors(),
    };
    const exists = library.items.some(item => item.factorFamilyId === payload.factorFamilyId && item.createdAt);
    const url = exists ? `/api/modules/factors/v1/library/submissions/${encodeURIComponent(payload.factorFamilyId)}` : '/api/modules/factors/v1/library/submissions';
    const response = await fetch(url, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    form.querySelector('.form-message').textContent = response.ok ? `已保存：${result.item.factorFamilyId} · revision ${result.item.revision}` : (result.errors?.join('；') || result.error || '保存失败');
  });
  panel.append(head, form);
  return panel;
}
function positioningPlot(items, mode = 'solo') {
  items = items.filter(item => Number.isFinite(item.marginal) && Number.isFinite(mode === 'rule' ? item.ruleDegree : item.soloExcess));
  const width = 520;
  const height = 280;
  const pad = 38;
  const xValues = items.map(item => item.soloExcess);
  const yValues = items.map(item => item.marginal);
  const maxAbsX = Math.max(...xValues.map(Math.abs), 0.01);
  const maxAbsY = Math.max(...yValues.map(Math.abs), 0.01);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'position-chart', role: 'img' });
  const x0 = mode === 'rule' ? pad + (width - pad * 2) * .7 : width / 2;
  const y0 = height / 2;
  root.append(svg('line', { x1: pad, x2: width - pad, y1: y0, y2: y0, class: 'chart-grid strong' }));
  root.append(svg('line', { x1: x0, x2: x0, y1: pad, y2: height - pad, class: 'chart-grid strong' }));
  for (const item of items) {
    const x = mode === 'rule' ? pad + item.ruleDegree * (width - pad * 2) : x0 + (item.soloExcess / maxAbsX) * (width / 2 - pad);
    const y = y0 - (item.marginal / maxAbsY) * (height / 2 - pad);
    const color = item.kind === 'sb' ? '#46B8E0' : '#FFB020';
    const dot=svg('circle', { cx: x, cy: y, r: 8 + item.weight * 18, fill: color, opacity: '0.82' });
    const title=svg('title');title.textContent=`${item.label} · ${mode==='rule'?item.ruleDegree:fmtPct(item.soloExcess)} · 边际 ${fmtPct(item.marginal)}`;dot.append(title);root.append(dot);
    const near = x > width - pad - 60;
    const label = svg('text', { x: near ? x - 10 : x + 10, y: y - 8, 'text-anchor': near ? 'end' : 'start', class: 'chart-label' });
    label.textContent = item.label;
    root.append(label);
  }
  const xLabel = svg('text', { x: pad, y: height - 10, class: 'chart-axis' });
  xLabel.textContent = mode === 'rule' ? '规则化程度 0–1（定性）' : '单因子超额';
  const yLabel = svg('text', { x: width - 118, y: height - 10, class: 'chart-axis' });
  yLabel.textContent = '边际贡献';
  root.append(xLabel, yLabel);
  return root;
}
async function factorsPanel() {
  const panel = element('section', null, 'factor-workbench');
  const [libraryResponse, submissionsResponse] = await Promise.all([
    fetch('/api/modules/factors/v1/library'),
    fetch('/api/modules/factors/v1/library/submissions'),
  ]);
  if (!libraryResponse.ok || !submissionsResponse.ok) throw new Error('因子库暂不可用');
  let library = await libraryResponse.json();
  let submissions = await submissionsResponse.json();
  const toolbar = element('section', null, 'factor-toolbar');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索因子族、字段、公式或注释';
  search.name = 'q';
  const category = document.createElement('select');
  category.name = 'category';
  category.append(new Option('全部类别', ''));
  for (const item of [...new Set(library.items.map(x => x.category).filter(Boolean))].sort()) category.append(new Option(item, item));
  const stats = element('p', '', 'factor-stats');
  toolbar.append(search, category, stats);
  const list = element('section', null, 'factor-list');
  const form = document.createElement('form');
  form.className = 'factor-form';
  form.innerHTML = `
    <h2>提交或修改因子定义</h2>
    <p>先入库定义与使用逻辑，不计算因子值。已有自定义因子使用相同 ID 提交修改。</p>
    <div class="form-grid">
      <label>因子族 ID<input name="factorFamilyId" placeholder="library.custom.my_factor"></label>
      <label>标题<input name="title" required placeholder="例如：基金经理稳定性"></label>
      <label>适用范围<input name="universe" required placeholder="public_funds / sw_industry_and_etf_proxy"></label>
      <label>类别<input name="category" required placeholder="quality / fees / custom"></label>
      <label>频率<input name="frequency" required placeholder="monthly / quarterly"></label>
      <label>适用 snapshot<input name="snapshotIds" placeholder="snapshot.fund_warehouse.wide_today.current"></label>
    </div>
    <label>计算逻辑<textarea name="calculationLogic" required placeholder="写清楚因子如何计算、如何标准化、是否需要滞后、是否需要分组中性化。"></textarea></label>
    <label>使用逻辑<textarea name="usageLogic" required placeholder="写清楚用于排序、过滤、风控、解释、组合约束还是实验候选，以及不可比较边界。"></textarea></label>
    <label>研究注释<textarea name="researchNotes" placeholder="可写论文来源、业界口径、自研假设、风险和待验证问题。"></textarea></label>
    <div class="subfactor-box">
      <h3>子因子 / 指标</h3>
      <div class="form-grid">
        <label>字段名<input name="field" required placeholder="manager_tenure_days"></label>
        <label>字段名称<input name="fieldName" required placeholder="基金经理任职天数"></label>
        <label>角色<input name="role" required placeholder="sub_factor / risk_metric / filter"></label>
        <label>方向<input name="direction" required placeholder="higher_is_better / lower_is_better"></label>
      </div>
      <label>字段公式<textarea name="formula" required placeholder="as_of_date - manager_start_date"></textarea></label>
      <label>字段定义和注释<textarea name="definition" placeholder="指标含义、边界和口径。"></textarea></label>
      <label>字段使用逻辑<textarea name="fieldUsageLogic" placeholder="这个字段在实验、筛选或回测里如何使用。"></textarea></label>
      <label>缺失值策略<textarea name="missingValuePolicy" required placeholder="missing remains missing / 分组内中位数填充 / 不参与排序"></textarea></label>
    </div>
    <div class="form-actions"><button type="submit">提交到因子库</button><button type="button" name="clear">清空</button></div>
    <p class="form-message" role="status"></p>
  `;
  function fillForm(item) {
    form.elements.factorFamilyId.value = item.factorFamilyId || '';
    form.elements.title.value = item.title || '';
    form.elements.universe.value = item.universe || '';
    form.elements.category.value = item.category || '';
    form.elements.frequency.value = item.frequency || '';
    form.elements.snapshotIds.value = (item.snapshotIds || []).join(', ');
    form.elements.calculationLogic.value = item.calculationLogic || item.fields?.map(x => `${x.field}: ${x.formula}`).join('\n') || '';
    form.elements.usageLogic.value = item.usageLogic || item.notes || '';
    form.elements.researchNotes.value = item.researchNotes || item.notes || '';
    const first = item.fields?.[0] || {};
    form.elements.field.value = first.field || '';
    form.elements.fieldName.value = first.name || '';
    form.elements.role.value = first.role || '';
    form.elements.direction.value = first.direction || '';
    form.elements.formula.value = first.formula || '';
    form.elements.definition.value = first.definition || '';
    form.elements.fieldUsageLogic.value = first.usageLogic || '';
    form.elements.missingValuePolicy.value = first.missingValuePolicy || '';
    form.querySelector('.form-message').textContent = item.createdAt ? '正在修改已提交因子。' : '已复制到表单，可作为新提交调整后入库。';
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderList() {
    const q = search.value.trim().toLowerCase();
    const c = category.value;
    const rows = library.items.filter(item => {
      const text = JSON.stringify(item).toLowerCase();
      return (!q || text.includes(q)) && (!c || item.category === c);
    });
    stats.textContent = `${rows.length} / ${library.count} 个因子族 · ${library.fieldCount} 个字段 · 自定义 ${library.submittedCount}`;
    list.replaceChildren();
    for (const item of rows) {
      const card = element('article', null, 'factor-card');
      const top = element('div', null, 'factor-card-top');
      top.append(element('small', `${item.category} · ${item.universe}`), element('span', item.createdAt ? '本地提交' : '内置库', 'status'));
      const fieldText = item.fields.slice(0, 5).map(x => `${x.name || x.field}：${x.direction}`).join(' / ');
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = item.createdAt ? '修改' : '复制';
      action.addEventListener('click', () => item.executionSpec ? editExpressionFactor?.(item) : fillForm(item));
      card.append(top, element('h3', item.title), element('p', item.notes || item.usageLogic || '待补充使用说明。'), element('p', fieldText, 'factor-fields'), action);
      list.append(card);
    }
  }
  search.addEventListener('input', renderList);
  category.addEventListener('change', renderList);
  form.elements.clear.addEventListener('click', () => { form.reset(); form.querySelector('.form-message').textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const id = formValue(form, 'factorFamilyId');
    const payload = {
      factorFamilyId: id,
      title: formValue(form, 'title'),
      universe: formValue(form, 'universe'),
      category: formValue(form, 'category'),
      frequency: formValue(form, 'frequency'),
      snapshotIds: splitList(formValue(form, 'snapshotIds')),
      calculationLogic: formValue(form, 'calculationLogic'),
      usageLogic: formValue(form, 'usageLogic'),
      researchNotes: formValue(form, 'researchNotes'),
      fields: [{
        field: formValue(form, 'field'),
        name: formValue(form, 'fieldName'),
        role: formValue(form, 'role'),
        formula: formValue(form, 'formula'),
        direction: formValue(form, 'direction'),
        missingValuePolicy: formValue(form, 'missingValuePolicy'),
        definition: formValue(form, 'definition'),
        usageLogic: formValue(form, 'fieldUsageLogic'),
      }],
    };
    const exists = submissions.items.some(item => item.factorFamilyId === id);
    const url = exists ? `/api/modules/factors/v1/library/submissions/${encodeURIComponent(id)}` : '/api/modules/factors/v1/library/submissions';
    const response = await fetch(url, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    const msg = form.querySelector('.form-message');
    if (!response.ok) {
      msg.textContent = result.errors?.join('；') || result.error || '提交失败';
      return;
    }
    msg.textContent = `已入库：${result.item.factorFamilyId} · revision ${result.item.revision}`;
    library = await (await fetch('/api/modules/factors/v1/library')).json();
    submissions = await (await fetch('/api/modules/factors/v1/library/submissions')).json();
    renderList();
  });
  panel.append(element('p', '因子库现在支持查询、提交和修改。本阶段只入库定义、计算逻辑、使用逻辑、子因子/指标和注释，不计算因子值。', 'intro'), toolbar, list, form);
  renderList();
  return panel;
}
let refreshFactorExecution = null;
function cashflowAttributionPanel(attribution) {
  if (attribution?.status !== 'computed_cashflow_accounting_v1') return null;
  const panel = element('section', null, 'result-attribution');
  const names = { cashExposure: '现金与模拟利息相对损益', wealthDifferenceCarry: '既有账户差的基准延续', managementFee: '显式年费差', tradingCost: '交易/申购费用差',
    'sleeve:A': 'A档持仓相对损益', 'sleeve:B': 'B档持仓相对损益', 'sleeve:C': 'C档持仓相对损益',
    'asset:hs300_tr': '沪深300持仓相对损益', 'asset:zz1000_tr': '中证1000持仓相对损益' };
  const label = key => names[key] || (key.startsWith('fund:') ? `基金 ${key.slice(5)} 相对损益` : key);
  const r = attribution.reconciliation;
  const keys = attribution.buckets.map(row => row.key);
  panel.append(element('h3', '同现金流账户终值归因'), element('p', attribution.explanation),
    resultDiagnosticTable('全期金额贡献（非收益率）', ['项目', '金额'], attribution.buckets.map(row => [label(row.key), fmtNum(row.value, 2)])),
    resultDiagnosticTable('资金与损益核对', ['累计投入', '策略损益', '基准损益', '实际终值差', '贡献合计', '闭合误差'],
      [[r.totalContributed, r.strategyProfit, r.benchmarkProfit, r.actualTerminalExcessValue, r.componentsTotal].map(value => fmtNum(value, 2)).concat(String(r.error))]));
  const month = document.createElement('select'); month.setAttribute('aria-label', '现金流归因月份');
  month.append(option('', '全期')); attribution.monthly.forEach(row => month.append(option(row.month, row.month)));
  const holder = element('div');
  const draw = () => holder.replaceChildren(resultDiagnosticTable('月度金额贡献（非当月收益率）', ['月份', '投入', ...keys.map(label), '终值差变动'],
    attribution.monthly.filter(row => !month.value || row.month === month.value).map(row => [row.month, fmtNum(row.deposit, 2), ...keys.map(key => fmtNum(row.components[key], 2)), fmtNum(row.total, 2)])));
  month.addEventListener('change', draw); draw(); panel.append(month, holder);
  const logic = document.createElement('details'); logic.append(element('summary', '现金流归因口径与逐日审计'));
  attribution.calculationLogic.forEach(text => logic.append(element('p', text)));
  logic.append(resultDiagnosticTable('最近30个现金流归因观测', ['日期', '投入', '策略损益', '基准损益', '终值差变动', '误差'],
    attribution.daily.slice(-30).map(row => [row.date, ...['deposit', 'strategyProfit', 'benchmarkProfit', 'total'].map(key => fmtNum(row[key], 2)), String(row.error)])));
  panel.append(logic); return panel;
}

function industryAttributionPanel(attribution) {
  if (attribution?.status !== 'computed_industry_accounting_v1') return null;
  const panel = element('section', null, 'result-attribution');
  const labels = { cashExposure: '现金暴露机会成本', industrySelection: '行业相对选择', managementFee: '持仓年费', tradingCost: '交易成本',
    marketBetaRelative: '相对市场Beta', sampleIntercept: '样本截距', regressionResidual: '回归残差' };
  const r = attribution.reconciliation, regression = attribution.regression;
  panel.append(element('h3', '行业超额收益拆解'), element('p', attribution.explanation),
    resultDiagnosticTable('终值收益贡献（非年化）', ['项目', '贡献'], attribution.buckets.map(b => [labels[b.key] || b.key, fmtPct(b.value)])),
    resultDiagnosticTable('闭合校验', ['实际终值超额', '贡献合计', '数值误差'], [[fmtPct(r.actualTerminalExcess), fmtPct(r.componentsTotal), String(r.error)]]));
  const month = document.createElement('select'); month.setAttribute('aria-label', '归因月份');
  month.append(option('', '全期')); attribution.monthly.forEach(row => month.append(option(row.month, row.month)));
  const rows = element('div');
  const draw = () => {
    const selected = attribution.monthly.filter(row => !month.value || row.month === month.value);
    rows.replaceChildren(resultDiagnosticTable('月度全期链接贡献（非当月收益率）', ['月份', '现金暴露', '行业选择', '年费', '交易成本', '合计'],
      selected.map(row => [row.month, ...['cashExposure', 'industrySelection', 'managementFee', 'tradingCost', 'total'].map(key => fmtPct(row[key]))])));
  };
  month.addEventListener('change', draw); draw(); panel.append(month, rows);
  if (regression.status === 'computed_sample_diagnostic') panel.append(
    resultDiagnosticTable('单基准样本回归', ['Beta', '每观测截距', 'R²', '观测数'], [[fmtNum(regression.benchmarkBeta, 4), fmtPct(regression.interceptPerObservation), fmtNum(regression.rSquared, 4), regression.observations]]),
    resultDiagnosticTable('回归链接贡献（非投资Alpha）', ['项目', '终值贡献'], regression.buckets.map(b => [labels[b.key] || b.key, fmtPct(b.value)])));
  else panel.append(element('p', '基准收益无变化或样本不足，回归不可识别。', 'warning'));
  panel.append(element('p', 'Smart Beta：缺少独立因子收益序列，未计算。', 'next'));
  const logic = document.createElement('details'); logic.append(element('summary', '计算口径与逐日审计'));
  attribution.calculationLogic.forEach(text => logic.append(element('p', text)));
  logic.append(resultDiagnosticTable('最近30个归因观测', ['日期', '期初股票暴露', '净收益', '基准收益', '算术超额', '链接权重'],
    attribution.daily.slice(-30).map(row => [row.date, fmtPct(row.openingExposure), fmtPct(row.strategyReturn), fmtPct(row.benchmarkReturn), fmtPct(row.arithmeticExcess), fmtNum(row.linkWeight, 6)])));
  panel.append(logic); return panel;
}

function proxyRiskPanel(model) {
  if (!model) return null;
  const panel = element('section', null, 'result-attribution');
  panel.append(element('h3', '多因子代理风险诊断'), element('p', model.warning, 'warning'));
  if (model.status !== 'computed_proxy_multifactor_diagnostic') {
    const reasons = { constant_proxy: '代理收益列无变化', insufficient_observations: '观测不足', collinear_or_ill_conditioned_proxies: '代理共线或病态，无法识别独立系数', proxy_unavailable: '代理重跑失败', proxy_budget_exceeded: '超过8个输出代理的计算上限' };
    panel.append(element('p', `未计算：${reasons[model.reason] || model.reason}。样本 ${model.observations}，代理 ${model.basis.join(' / ')}。`));
    return panel;
  }
  panel.append(resultDiagnosticTable('样本回归系数', ['代理', '系数'], model.loadings.map(row => [row.key, fmtNum(row.coefficient, 6)])),
    resultDiagnosticTable('链接终值贡献（非年化）', ['项目', '贡献'], model.linkedContributions.map(row => [row.key, fmtPct(row.value)])),
    resultDiagnosticTable('年化跟踪方差贡献（允许负值）', ['项目', '方差贡献', '占比'], model.riskContributions.map(row => [row.key, fmtNum(row.varianceContribution, 8), fmtPct(row.share)])),
    resultDiagnosticTable('模型校验', ['观测', '秩 / 列数', '条件数', '终值误差', '方差误差'], [[model.observations, `${model.rank} / ${model.columns}`, fmtNum(model.conditionNumber, 4), String(model.reconciliation.terminalExcessError), String(model.reconciliation.varianceError)]]));
  const details = document.createElement('details'); details.append(element('summary', '模型口径与逐日审计'));
  model.calculationLogic.forEach(text => details.append(element('p', text)));
  details.append(resultDiagnosticTable('最近30个诊断观测', ['日期', '超额收益', '模型残差'], model.daily.slice(-30).map(row => [row.date, fmtPct(row.excessReturn), fmtPct(row.components.model_residual)])));
  panel.append(details); return panel;
}

function resultDiagnosticTable(title, headers, rows) {
  const section = element('section', null, 'result-diagnostic-table');
  section.append(element('h4', title));
  if (!rows.length) { section.append(element('p', '暂无数据。', 'next')); return section; }
  const table = document.createElement('table');
  const thead = document.createElement('thead'); const headRow = document.createElement('tr');
  headers.forEach(header => headRow.append(element('th', header))); thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const row of rows) { const tr = document.createElement('tr'); row.forEach(value => tr.append(element('td', String(value ?? '-')))); tbody.append(tr); }
  table.append(thead, tbody); section.append(table); return section;
}

async function industryConfigPanel(library) {
  const panel = element('section', null, 'strategy-config-workbench');
  panel.id = 'industry-config';
  panel.append(element('h2', '原始行业回测配置'));
  const response = await fetch('/api/modules/factors/v1/industry-engine/options');
  if (!response.ok) { panel.append(element('p', '行业计算定义暂时无法读取。', 'warning')); return panel; }
  const definitions = await response.json();
  let configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
  const template = configs.templates.find(item => item.strategyTemplateId === 'strategy.industry_parquet_monthly_topn');
  const form = document.createElement('form');
  form.className = 'strategy-config-card';
  form.innerHTML = `<div class="strategy-grid-form">
    <label>已保存配置<select name="savedConfig"></select></label>
    <label>配置ID<input name="configId" value="config.industry_parquet_manual" required></label>
    <label>标题<input name="title" value="原始行业月度TopN" required></label>
    <label>数据版本<select name="snapshotId" required></select></label>
    <label>开始日期<input name="startDate" type="date" value="2016-01-04" required></label>
    <label>结束日期<input name="endDate" type="date" value="2026-07-30" required></label>
    <label>Top N<input name="topN" type="number" min="1" max="20" value="3" required></label>
    <label>最少合格行业<input name="minInvestable" type="number" min="1" max="31" value="8" required></label>
    <label>信号滞后数据日<input name="signalLagDays" type="number" min="1" max="20" value="1" required></label>
    <label>基准<select name="benchmarkId"><option value="hs300_total_return">沪深300全收益</option></select></label>
    <label>调仓<select name="rebalanceCalendar"><option value="monthly">月度首个数据日收盘</option></select></label>
    <label>组合权重<select name="weightingMethod"><option value="equal_weight">TopN等权</option></select></label>
    <label>单边佣金<input name="commission" type="number" min="0" max="0.1" step="0.00001" value="0.00025" required></label>
    <label>单边滑点<input name="slippage" type="number" min="0" max="0.1" step="0.00001" value="0.0005" required></label>
    <label>行业年费率<input name="annual_fee" type="number" min="0" max="0.1" step="0.0001" value="0.006" required></label>
  </div><div class="factor-weight-list"></div>
  <label>备注<textarea name="notes"></textarea></label>
  <p class="next">行业指数代理，非真实ETF成交。财务披露时点与历史成分未核验；合格行业不足时持现金，现金收益为零。费用只扣一次，基准为毛全收益指数。</p>
  <div class="form-actions"><button type="submit">保存行业回测配置</button><button type="button" name="newConfig">新建配置</button></div><p class="form-message" role="status"></p>`;
  const fields = [];
  for (const family of definitions.families) {
    const definition = library.items.find(item => item.factorFamilyId === family.familyId);
    const row = element('label', null, 'weight-row');
    const check = document.createElement('input'); check.type = 'checkbox'; check.value = family.familyId;
    const weight = document.createElement('input'); weight.type = 'number'; weight.min = '0.01'; weight.max = '100'; weight.step = '0.01'; weight.value = '1';
    weight.setAttribute('aria-label', `${definition?.title || family.familyId} 权重`);
    row.append(element('span', family.familyId === 'library.industry.size_liquidity' ? '成交占比流动性（非市值规模）' : definition?.title || family.familyId), element('small', '相对权重'), check, weight);
    form.querySelector('.factor-weight-list').append(row);
    const entry = { id: family.familyId, check, weight, slots: [] }; fields.push(entry);
    const detail = document.createElement('details'); detail.append(element('summary', `${definition?.title || family.familyId} · 计算槽位`));
    for (const slot of family.slots) {
      const line = element('label', null, 'weight-row'), enabled = document.createElement('input'), relative = document.createElement('input');
      enabled.type = 'checkbox'; enabled.checked = true; enabled.setAttribute('aria-label', `${slot.field} 子因子启用`);
      relative.type = 'number'; relative.min = '0'; relative.max = '100'; relative.step = '0.01'; relative.value = slot.weight; relative.setAttribute('aria-label', `${slot.field} 子因子相对权重`);
      line.append(enabled, element('span', slot.field), relative, element('small', `${slot.formula} · ${slot.sign > 0 ? '高值优先' : '低值优先'}`)); detail.append(line);
      entry.slots.push({ field: slot.field, defaultWeight: slot.weight, enabled, relative });
    }
    panel.append(detail);
  }
  const slotActions = element('div');
  for (const [label, action] of [['清零全部因子', () => fields.forEach(f => { f.check.checked = false; f.slots.forEach(s => {s.enabled.checked = false;s.relative.value = '0';}); })],
    ['恢复模板因子权重', () => fields.forEach(f => {f.check.checked = template.factorFamilyIds.includes(f.id);f.weight.value = template.factorWeights.find(w => w.factorFamilyId === f.id)?.weight || 1;f.slots.forEach(s => {s.enabled.checked = true;s.relative.value = s.defaultWeight;});})]]) {
    const button = element('button', label); button.type = 'button'; button.addEventListener('click', action); slotActions.append(button);
  }
  form.querySelector('.factor-weight-list').append(slotActions);
  await populateSnapshotSelect(form.elements.snapshotId, 'snapshot.etf_smartbeta.industry_execution.current');
  refreshIndustrySnapshotChoices = async () => { if (panel.isConnected) await populateSnapshotSelect(form.elements.snapshotId, 'snapshot.etf_smartbeta.industry_execution.current'); };
  let generation = 0;
  let saving = false;
  let editingId = null;
  const message = form.querySelector('.form-message');
  function renderSaved() {
    const selected = form.elements.configId.value;
    form.elements.savedConfig.replaceChildren(option('', '新配置'));
    configs.items.filter(item => item.strategyTemplateId === 'strategy.industry_parquet_monthly_topn').forEach(item => form.elements.savedConfig.append(option(item.configId, `${item.title} · revision ${item.revision}`)));
    form.elements.savedConfig.value = selected;
  }
  function fill(item) {
    generation += 1;
    const s = item.strategySettings || {};
    editingId = item.configId || null;
    form.elements.configId.value = item.configId || nextIndustryConfigId(configs.items);
    form.elements.title.value = item.title || '';
    const id = item.snapshotId || template.snapshotId;
    if (![...form.elements.snapshotId.options].some(o => o.value === id)) form.elements.snapshotId.append(option(id, `原配置版本：${id}`));
    form.elements.snapshotId.value = id;
    for (const key of ['startDate', 'endDate', 'topN', 'minInvestable', 'signalLagDays', 'weightingMethod']) form.elements[key].value = s[key] ?? template.strategySettings[key];
    form.elements.benchmarkId.value = item.benchmarkId || template.benchmarkId;
    form.elements.rebalanceCalendar.value = item.rebalanceCalendar || template.rebalanceCalendar;
    const rates = Object.fromEntries((item.costModel || template.costModel).split(';').filter(x => x.trim()).map(x => x.trim().split('=').map(y => y.trim())));
    for (const key of ['commission', 'slippage', 'annual_fee']) form.elements[key].value = rates[key] || '0';
    form.elements.notes.value = item.notes || '';
    for (const field of fields) {
      field.check.checked = (item.factorFamilyIds || []).includes(field.id);
      field.weight.value = item.factorWeights?.find(w => w.factorFamilyId === field.id)?.weight || '1';
      for (const slot of field.slots) {
        const saved = s.slotWeights?.find(w => w.familyId === field.id && w.field === slot.field);
        slot.relative.value = saved?.weight ?? slot.defaultWeight;
        slot.enabled.checked = Number(slot.relative.value) > 0;
      }
    }
    message.textContent = '';
    renderSaved();
  }
  editIndustryConfig = async item => {
    const requestGeneration = ++generation;
    try {
      const response = await fetch('/api/modules/factors/v1/experiment-configs');
      if (!response.ok) throw new Error('无法刷新草案库。');
      const refreshed = await response.json();
      if (generation !== requestGeneration) return;
      configs = refreshed;
      const current = item.configId ? latestIndustryConfig(configs.items, item.configId) : template;
      if (!current) { message.textContent = '该草案已不存在，未恢复旧参数。'; return; }
      fill(current); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { if (generation === requestGeneration) message.textContent = '草案刷新失败。'; }
  };
  form.elements.savedConfig.addEventListener('change', () => fill(configs.items.find(item => item.configId === form.elements.savedConfig.value) || template));
  form.elements.newConfig.addEventListener('click', () => fill(template));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const factorWeights = fields.filter(field => field.check.checked).map(field => ({ factorFamilyId: field.id, weight: Number(field.weight.value) }));
    if (!factorWeights.length || factorWeights.some(x => !Number.isFinite(x.weight) || x.weight <= 0)) { message.textContent = '至少选择一个因子，并设置正权重。'; return; }
    const slotWeights = fields.filter(f => f.check.checked).flatMap(f => f.slots.map(s => ({familyId:f.id,field:s.field,weight:s.enabled.checked ? Number(s.relative.value) : 0})));
    if (slotWeights.some(s => !Number.isFinite(s.weight) || s.weight < 0 || s.weight > 100) || factorWeights.some(f => !slotWeights.some(s => s.familyId === f.factorFamilyId && s.weight > 0))) { message.textContent = '每个启用因子至少保留一个正权重子因子；子因子权重须为0至100。'; return; }
    if (Number(form.elements.minInvestable.value) < Number(form.elements.topN.value)) { message.textContent = '最少合格行业不能小于TopN。'; return; }
    const configId = formValue(form, 'configId');
    const sentGeneration = generation;
    const payload = { ...template, configId, title: formValue(form, 'title'), snapshotId: formValue(form, 'snapshotId'), benchmarkId: formValue(form, 'benchmarkId'), rebalanceCalendar: formValue(form, 'rebalanceCalendar'),
      factorFamilyIds: factorWeights.map(x => x.factorFamilyId), factorWeights, notes: formValue(form, 'notes'),
      costModel: ['commission', 'slippage', 'annual_fee'].map(key => `${key}=${formValue(form, key)}`).join(';'),
      strategySettings: { startDate: formValue(form, 'startDate'), endDate: formValue(form, 'endDate'), topN: Number(form.elements.topN.value), minInvestable: Number(form.elements.minInvestable.value), signalLagDays: Number(form.elements.signalLagDays.value), weightingMethod: formValue(form, 'weightingMethod'), missingValuePolicy: 'neutral_with_coverage', slotWeights } };
    const method = industrySaveMethod(editingId, configId);
    saving = true;
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      const response = await fetch(method === 'PUT' ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(configId)}` : '/api/modules/factors/v1/experiment-configs', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (isCurrentFundEdit(configId, sentGeneration, formValue(form, 'configId'), generation)) {
        message.textContent = response.ok ? `已保存：${result.item.configId} · revision ${result.item.revision}` : result.errors?.join('；') || result.error || '保存失败';
        if (response.ok) editingId = result.item.configId;
      }
      if (response.ok) { configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json(); renderSaved(); await refreshFactorExecution?.(); }
    } catch { if (generation === sentGeneration) message.textContent = '保存请求失败。'; }
    finally { saving = false; submit.disabled = false; }
  });
  panel.insertBefore(form, panel.children[1] || null);
  fill(template);
  return panel;
}

async function threeBucketConfigPanel(library) {
  const panel = element('section', null, 'strategy-config-workbench');
  panel.id = 'three-bucket-config';
  panel.append(element('h2', 'A/B/C三档定投配置'));
  const response = await fetch('/api/modules/factors/v1/three-bucket-engine/options');
  if (!response.ok) { panel.append(element('p', '三档计算定义读取失败。', 'warning')); return panel; }
  const definitions = await response.json();
  let configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
  const template = configs.templates.find(item => item.strategyTemplateId === 'strategy.legacy_three_bucket_monthly');
  const form = document.createElement('form'); form.className = 'strategy-config-card';
  const grid = element('div', null, 'strategy-grid-form');
  const controls = {};
  function field(key, title, type = 'number', choices = null) {
    const label = element('label', title);
    const control = document.createElement(choices ? 'select' : 'input'); control.name = key;
    if (choices) choices.forEach(([value, text]) => control.append(option(value, text)));
    else { control.type = type; if (type === 'number') { control.step = 'any'; control.min = '0'; } }
    control.required = type !== 'checkbox'; label.append(control); grid.append(label); controls[key] = control;
    return control;
  }
  field('savedConfig', '已保存配置', 'text', [['', '新配置']]).required = false;
  field('configId', '配置ID', 'text'); field('title', '标题', 'text');
  field('snapshotId', '八文件数据版本', 'text', []);
  const labels = { startDate: '开始日期', endDate: '结束日期', amount: '每月投入金额', bucketA: 'A宽基档比例', bucketB: 'B行业档比例', bucketC: 'C择时档比例', hs300Weight: 'A档沪深300比例',
    topN: 'B档Top N', minInvestable: '最少合格行业', holdingLimitMonths: 'B持仓月数上限', signalLagDays: '信号滞后数据日', peGate: 'PE分位停投阈值', peLookback: 'PE窗口数据日', peMinObservations: 'PE最少观测', trendGate: '启用200日趋势闸门',
    missingPePolicy: 'PE缺失口径', basisLookback: '基差窗口数据日', basisMinObservations: '基差最少观测', macroLookbackMonths: '宏观窗口月数', macroMinObservations: '宏观最少观测',
    maxMacroAgeDays: '宏观可用日最大年龄', maxBasisAgeDays: '基差最大年龄', missingTimingPolicy: '择时缺失口径', neutralEquity: '全缺失中性股票比例', pmiLagMonths: 'PMI日历滞后月数', m2LagMonths: 'M2日历滞后月数', shiborLagMonths: 'Shibor日历滞后月数', cashRate: 'A/B现金模拟年收益率', bondRate: 'C现金模拟债券年收益率', broadAnnualFee: '宽基持仓年费', sectorAnnualFee: '行业持仓年费' };
  for (const [key, value] of Object.entries(definitions.defaults)) {
    if (key === 'missingPePolicy') field(key, labels[key], 'text', [['open_with_warning', '缺失时开闸并标警示'], ['hold_cash', '缺失时留现金']]);
    else if (key === 'holdingLimitPolicy') field(key, 'B持仓期限口径', 'text', [['legacy_days_30_44', '旧版：每月30.44天'], ['calendar_months', '日历月到期（包含短月份）']]);
    else if (key === 'missingTimingPolicy') field(key, labels[key], 'text', [['available_mean_else_neutral', '可用信号均值，否则中性比例']]);
    else field(key, labels[key], typeof value === 'boolean' ? 'checkbox' : key.endsWith('Date') ? 'date' : 'number');
  }
  field('commission', '单边佣金'); field('slippage', '单边滑点');
  const weightList = element('div', null, 'factor-weight-list');
  const weights = definitions.families.map(id => {
    const label = element('label', null, 'weight-row');
    const check = document.createElement('input'); check.type = 'checkbox';
    const weight = document.createElement('input'); weight.type = 'number'; weight.min = '.01'; weight.max = '100'; weight.step = '.01';
    const title = library.items.find(item => item.factorFamilyId === id)?.title || id;
    weight.setAttribute('aria-label', `${title} B档权重`);
    label.append(element('span', title), check, weight); weightList.append(label); return { id, check, weight };
  });
  const notesLabel = element('label', '备注'); const notes = document.createElement('textarea'); notes.name = 'notes'; notesLabel.append(notes);
  const actions = element('div', null, 'form-actions'); const submit = element('button', '保存三档配置'); submit.type = 'submit';
  const fresh = element('button', '新建配置'); fresh.type = 'button'; actions.append(submit, fresh);
  const message = element('p', '', 'form-message'); message.setAttribute('role', 'status');
  form.append(grid, weightList, notesLabel, element('p', '月度首个共同数据日收盘定投。B比例大于0时取宽基／行业日期交集；宽基／行业指数代理，C现金是固定收益率模型。宏观滞后为假设，不是已核验的发布日期；基准不扣费。', 'next'), actions, message);
  panel.append(form);
  await populateSnapshotSelect(controls.snapshotId, template.snapshotId);
  refreshThreeBucketSnapshotChoices = async () => { if (panel.isConnected) await populateSnapshotSelect(controls.snapshotId, template.snapshotId); };
  let editingId = null, generation = 0, saving = false, loading = false;
  function renderSaved() {
    const selected = controls.savedConfig.value;
    controls.savedConfig.replaceChildren(option('', '新配置'));
    configs.items.filter(item => item.strategyTemplateId === template.strategyTemplateId).forEach(item => controls.savedConfig.append(option(item.configId, `${item.title} · revision ${item.revision}`)));
    controls.savedConfig.value = loading ? selected : editingId || '';
  }
  function fill(item) {
    generation += 1; editingId = item.configId || null; loading = false; submit.disabled = saving;
    let id = 'config.three_bucket_manual', index = 2;
    while (configs.items.some(item => item.configId === id)) id = `config.three_bucket_manual_${index++}`;
    controls.configId.value = editingId || id; controls.title.value = item.title;
    if (![...controls.snapshotId.options].some(o => o.value === item.snapshotId)) controls.snapshotId.append(option(item.snapshotId, `原配置版本：${item.snapshotId}`));
    controls.snapshotId.value = item.snapshotId;
    for (const [key, value] of Object.entries(definitions.defaults)) {
      if (typeof value === 'boolean') controls[key].checked = item.strategySettings?.[key] ?? value;
      else controls[key].value = item.strategySettings?.[key] ?? value;
    }
    const rates = Object.fromEntries(item.costModel.split(';').map(x => x.trim().split('=')));
    controls.commission.value = rates.commission ?? 0; controls.slippage.value = rates.slippage ?? 0;
    notes.value = item.notes || '';
    weights.forEach(row => { row.check.checked = item.factorFamilyIds.includes(row.id); row.weight.value = item.factorWeights?.find(x => x.factorFamilyId === row.id)?.weight ?? 1; });
    message.textContent = ''; renderSaved();
  }
  editThreeBucketConfig = async item => {
    const sent = ++generation;
    loading = true; submit.disabled = true; message.textContent = '正在加载草案。';
    try {
      const response = await fetch('/api/modules/factors/v1/experiment-configs');
      if (!response.ok) throw new Error('refresh_failed');
      const data = await response.json(); if (generation !== sent) return;
      configs = data;
      const latest = item.configId ? configs.items.find(x => x.configId === item.configId && x.strategyTemplateId === template.strategyTemplateId) : template;
      if (!latest) { message.textContent = '该草案已不存在，请重新选择或新建配置。'; return; }
      fill(latest); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { if (generation === sent) message.textContent = '草案刷新失败，请重新选择或新建配置。'; }
  };
  controls.savedConfig.addEventListener('change', () => editThreeBucketConfig({ configId: controls.savedConfig.value }));
  fresh.addEventListener('click', () => fill(template));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || loading) return;
    const factorWeights = weights.filter(row => row.check.checked).map(row => ({ factorFamilyId: row.id, weight: Number(row.weight.value) }));
    if (!factorWeights.length || factorWeights.some(x => !Number.isFinite(x.weight) || x.weight <= 0)) { message.textContent = '至少选择一个正权重行业因子。'; return; }
    const strategySettings = Object.fromEntries(Object.entries(definitions.defaults).map(([key, value]) => [key, typeof value === 'boolean' ? controls[key].checked : typeof value === 'number' ? Number(controls[key].value) : controls[key].value]));
    if (Math.abs(strategySettings.bucketA + strategySettings.bucketB + strategySettings.bucketC - 1) > 1e-8) { message.textContent = 'A/B/C比例必须合计1。'; return; }
    const configId = controls.configId.value.trim(), sent = generation;
    const method = industrySaveMethod(editingId, configId);
    const payload = { ...template, configId, title: controls.title.value.trim(), snapshotId: controls.snapshotId.value,
      factorFamilyIds: factorWeights.map(x => x.factorFamilyId), factorWeights, strategySettings, notes: notes.value,
      costModel: `commission=${controls.commission.value};slippage=${controls.slippage.value};annual_fee=0` };
    saving = true; submit.disabled = true;
    try {
      const response = await fetch(method === 'PUT' ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(configId)}` : '/api/modules/factors/v1/experiment-configs', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (isCurrentFundEdit(configId, sent, controls.configId.value.trim(), generation)) {
        message.textContent = response.ok ? `已保存：${data.item.configId} · revision ${data.item.revision}` : data.errors?.join('；') || data.error;
        if (response.ok) editingId = configId;
      }
      if (response.ok) { configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json(); renderSaved(); await refreshFactorExecution?.(); }
    } catch { if (generation === sent) message.textContent = '保存请求失败。'; }
    finally { saving = false; submit.disabled = loading; }
  });
  fill(template); return panel;
}

async function fundNavConfigPanel() {
  const panel = element('section', null, 'strategy-config-workbench'); panel.id = 'fund-nav-config';
  panel.append(element('h2', '基金历史净值定投'));
  const baseSnapshotId = 'snapshot.fund_warehouse.nav_db.current';
  const picker = document.createElement('select'); picker.name = 'snapshotId';
  await populateSnapshotSelect(picker, baseSnapshotId);
  let optionsResponse = await fetch('/api/modules/factors/v1/fund-nav/catalog');
  if (!optionsResponse.ok) {
    const fallback = [...picker.options].find(o => o.value !== baseSnapshotId && o.value.startsWith('snapshot.frozen.'));
    if (fallback) { picker.value = fallback.value; optionsResponse = await fetch(`/api/modules/factors/v1/fund-nav/catalog?snapshotId=${encodeURIComponent(picker.value)}`); }
  }
  const initialSnapshotId = picker.value;
  if (!optionsResponse.ok) { panel.append(element('p', '基金历史数据库未就绪。', 'warning')); return panel; }
  const options = await optionsResponse.json();
  const db = options.database;
  if (db) {
    const imported = db.lastImport;
    panel.append(element('p', db.selection ? 'SQLite · 冻结选定源（原始导入凭证，不含全库导入记录）' : `SQLite · ${imported?.status || '未导入'} · 本批导入${imported?.imported ?? 0} / 未变${imported?.skipped ?? 0} / 拒绝${imported?.rejected ?? 0}`),
      resultDiagnosticTable('数据库历史覆盖', ['数据', '来源数', '观测数', '起点', '终点'], db.sources.map(s => [s.kind, s.files, s.rows, s.start || '-', s.end || '-'])));
    if (db.rejectedSample.length) panel.append(resultDiagnosticTable('最近导入异常（最多20条）', ['来源', '原因'], db.rejectedSample.map(s => [s.source_id, s.message])));
  }
  let configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
  const template = configs.templates.find(item => item.strategyTemplateId === 'strategy.fund_nav_fixed_dca');
  const form = document.createElement('form'); form.className = 'strategy-config-card';
  const grid = element('div', null, 'strategy-grid-form'); const controls = {};
  function field(name, text, type = 'text', choices = null) {
    const label = element('label', text), input = document.createElement(choices ? 'select' : 'input'); input.name = name;
    if (choices) choices.forEach(([value, title]) => input.append(option(value, title)));
    else { input.type = type; if (type === 'number') { input.min = '0'; input.step = 'any'; } }
    input.required = name !== 'savedConfig'; label.append(input); grid.append(label); controls[name] = input; return input;
  }
  field('savedConfig', '已保存配置', 'text', [['', '新配置']]); field('configId', '配置ID'); field('title', '标题');
  const versionLabel = element('label', '基金净值数据版本'); versionLabel.append(picker); grid.append(versionLabel); controls.snapshotId = picker;
  refreshFundNavSnapshotChoices = async () => { if (panel.isConnected) await populateSnapshotSelect(picker, baseSnapshotId); };
  field('benchmarkId', '显式单指数基准', 'text', options.benchmarks.map(id => [id, id]));
  field('startDate', '开始日期', 'date'); field('endDate', '结束日期', 'date'); field('amount', '每笔投入金额', 'number');
  field('frequency', '投入频率', 'text', [['monthly', '月度'], ['weekly', '每7日'], ['biweekly', '每14日']]);
  field('maxGapDays', '共同数据日最大间隔', 'number'); field('subscription', '假设申购费率', 'number'); field('slippage', '假设滑点', 'number');
  const basket = element('div', null, 'factor-weight-list'); let rows = [];
  const catalogArea = element('section'); const query = document.createElement('input'); query.placeholder = '基金代码或名称'; query.setAttribute('aria-label', '搜索基金名录'); query.maxLength = 128;
  const search = element('button', '查询名录'); search.type = 'button';
  const choices = document.createElement('select'); choices.setAttribute('aria-label', '基金名录结果');
  const manual = document.createElement('input'); manual.placeholder = '六位份额代码'; manual.setAttribute('aria-label', '手动基金份额代码'); manual.maxLength = 6;
  const add = element('button', '加入篮子'); add.type = 'button';
  const equal = element('button', '等权'); equal.type = 'button';
  catalogArea.append(query, search, choices, manual, add, equal);
  const notesLabel = element('label', '备注'); const notes = document.createElement('textarea'); notesLabel.append(notes);
  const read = element('button', '读取数据库净值与基准'); read.type = 'button';
  const submit = element('button', '保存基金历史配置'); submit.type = 'submit';
  const fresh = element('button', '新建配置'); fresh.type = 'button';
  const freeze = element('button', '冻结已绑定基金数据'); freeze.type = 'button';
  const message = element('p', '', 'form-message'); message.setAttribute('role', 'status'); const profileView = element('section');
  form.append(grid, catalogArea, basket, notesLabel, element('p', '手动固定份额篮子，不按最新因子挑选历史标的。净值已含日常费用，不重复扣年费；申购与滑点为假设。基准为同现金流毛指数，复权净值份额不是实际申购确认。', 'next'), read, freeze, submit, fresh, message, profileView); panel.append(form);
  let editingId = null, generation = 0, editSession = 0, loading = false, profiling = false, saving = false, freezing = false, selecting = false, binding = null;
  const occupiedIds = new Set();
  function syncButtons() {
    submit.disabled = loading || profiling || saving || freezing || selecting || !binding; read.disabled = loading || profiling || freezing || selecting;
    freeze.disabled = loading || profiling || saving || freezing || selecting || !binding || picker.value !== baseSnapshotId;
    [picker, controls.benchmarkId, add, equal].forEach(control => { control.disabled = loading || freezing || selecting; });
  }
  function invalidate() { generation += 1; binding = null; profiling = false; profileView.replaceChildren(); syncButtons(); }
  function drawBasket(shares) {
    rows = []; basket.replaceChildren();
    for (const share of shares) {
      const row = element('label', null, 'weight-row'); const weight = document.createElement('input'); weight.type = 'number'; weight.min = '.000001'; weight.max = '1'; weight.step = 'any'; weight.value = share.weight;
      weight.setAttribute('aria-label', `${share.shareCode} 新投入比例`);
      const remove = element('button', '-'); remove.type = 'button'; remove.title = `移除${share.shareCode}`; remove.setAttribute('aria-label', remove.title);
      const item = { code: share.shareCode, weight };
      remove.addEventListener('click', () => { if (loading) return; const remaining = rows.filter(r => r !== item).map(r => ({ shareCode: r.code, weight: Number(r.weight.value) })); invalidate(); drawBasket(remaining); });
      row.append(element('span', share.shareCode), weight, remove); basket.append(row); rows.push(item);
    }
  }
  search.addEventListener('click', async () => {
    search.disabled = true;
    try {
      const id = picker.value;
      const response = await fetch(`/api/modules/factors/v1/fund-nav/catalog?q=${encodeURIComponent(query.value.trim())}&snapshotId=${encodeURIComponent(id)}`); const data = await response.json();
      if (id !== picker.value) return;
      if (!response.ok) throw new Error(data.error || '查询失败');
      choices.replaceChildren(option('', '选择份额'));
      data.items.forEach(item => choices.append(option(item.shareCode, `${item.shareCode} ${item.shareName}${item.historyAvailable ? '' : '（历史缺失）'}`)));
      message.textContent = data.hasMore ? '仅显示前50项，请缩小查询范围。' : `名录匹配${data.items.length}项，历史口径需单独读取。`;
    } catch { message.textContent = '名录查询失败。'; } finally { search.disabled = false; }
  });
  add.addEventListener('click', () => {
    if (loading) return;
    const code = manual.value.trim() || choices.value;
    if (!/^[0-9]{6}$/.test(code) || rows.some(r => r.code === code) || rows.length >= 10) { message.textContent = '请选择唯一六位代码，最多10个份额。'; return; }
    const shares = rows.map(r => ({ shareCode: r.code, weight: Number(r.weight.value) })); shares.push({ shareCode: code, weight: 1 });
    invalidate(); drawBasket(shares); manual.value = ''; choices.value = ''; message.textContent = '请设置合计1的投入比例，并读取历史数据口径。';
  });
  equal.addEventListener('click', () => { if (!loading) rows.forEach(row => { row.weight.value = 1 / rows.length; }); });
  controls.benchmarkId.addEventListener('change', () => { if (!loading) invalidate(); });
  picker.addEventListener('change', async () => {
    invalidate(); const sent = generation; selecting = true; syncButtons(); choices.replaceChildren();
    try {
      const response = await fetch(`/api/modules/factors/v1/fund-nav/catalog?snapshotId=${encodeURIComponent(picker.value)}`), data = await response.json();
      if (generation !== sent) return;
      if (!response.ok) throw new Error(data.error || '数据版本不可用');
      const previous = controls.benchmarkId.value;
      controls.benchmarkId.replaceChildren(...data.benchmarks.map(id => option(id, id)));
      controls.benchmarkId.value = data.benchmarks.includes(previous) ? previous : data.benchmarks[0] || '';
      message.textContent = '数据版本已切换，请重新读取净值与基准。';
    } catch (error) { if (generation === sent) message.textContent = error.message; }
    finally { if (generation === sent) { selecting = false; syncButtons(); } }
  });
  query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search.click(); } });
  manual.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } });
  function renderSaved() {
    const selected = controls.savedConfig.value;
    controls.savedConfig.replaceChildren(option('', '新配置'));
    configs.items.filter(item => item.strategyTemplateId === template.strategyTemplateId).forEach(item => controls.savedConfig.append(option(item.configId, `${item.title} · revision ${item.revision}`)));
    controls.savedConfig.value = loading ? selected : editingId || '';
  }
  function fill(item) {
    generation += 1; editSession += 1; loading = profiling = selecting = false; editingId = item.configId || null;
    const snapshotId = item.snapshotId || baseSnapshotId;
    if (![...picker.options].some(o => o.value === snapshotId)) picker.append(option(snapshotId, `原配置版本：${snapshotId}`));
    picker.value = snapshotId;
    let id = 'config.fund_nav_manual', index = 2; while (configs.items.some(x => x.configId === id) || occupiedIds.has(id)) id = `config.fund_nav_manual_${index++}`;
    controls.configId.value = editingId || id; controls.title.value = item.title;
    if (![...controls.benchmarkId.options].some(o => o.value === item.benchmarkId)) controls.benchmarkId.append(option(item.benchmarkId, `原配置：${item.benchmarkId}`));
    controls.benchmarkId.value = item.benchmarkId;
    const s = item.strategySettings || template.strategySettings;
    ['startDate', 'endDate', 'amount', 'frequency', 'maxGapDays'].forEach(key => { controls[key].value = s[key]; });
    const rates = Object.fromEntries(item.costModel.split(';').map(x => x.trim().split('=')));
    controls.subscription.value = rates.subscription ?? 0; controls.slippage.value = rates.slippage ?? 0; notes.value = item.notes || '';
    drawBasket(s.shares || []); binding = s.sourceVersions?.length ? s.sourceVersions : null;
    profileView.replaceChildren(); message.textContent = binding ? '保留数据库导入版本绑定；导入版本变化后执行需重读。' : '';
    renderSaved(); syncButtons();
  }
  editFundNavConfig = async item => {
    const sent = ++generation; editSession += 1; loading = true; message.textContent = '正在加载草案。'; syncButtons();
    try {
      const response = await fetch('/api/modules/factors/v1/experiment-configs'); const data = await response.json();
      if (generation !== sent) return; if (!response.ok) throw new Error('refresh_failed'); configs = data;
      const latest = item.configId ? configs.items.find(x => x.configId === item.configId && x.strategyTemplateId === template.strategyTemplateId) : template;
      if (!latest) { message.textContent = '草案不存在，请重新选择或新建。'; return; }
      fill(latest); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { if (generation === sent) message.textContent = '草案加载失败，请重新选择或新建。'; }
  };
  controls.savedConfig.addEventListener('change', () => editFundNavConfig({ configId: controls.savedConfig.value })); fresh.addEventListener('click', () => fill(template));
  read.addEventListener('click', async () => {
    if (loading || profiling || freezing || selecting || !rows.length) { message.textContent = '先选择基金份额。'; return; }
    const sent = ++generation; binding = null; profiling = true; syncButtons();
    try {
      const params = new URLSearchParams({ codes: rows.map(r => r.code).join(','), benchmarkId: controls.benchmarkId.value, snapshotId: picker.value });
      const response = await fetch(`/api/modules/factors/v1/fund-nav/profile?${params}`), data = await response.json();
      if (generation !== sent) return;
      if (!response.ok) throw new Error(data.error || '历史读取失败');
      binding = data.sourceVersions;
      if (controls.startDate.value < data.commonStartDate || controls.startDate.value > data.commonEndDate) controls.startDate.value = data.commonStartDate;
      if (controls.endDate.value > data.commonEndDate || controls.endDate.value <= controls.startDate.value) controls.endDate.value = data.commonEndDate;
      profileView.replaceChildren(element('p', `共同区间 ${data.commonStartDate} → ${data.commonEndDate} · ${data.commonObservations}观测 · 基准${data.benchmark.id}/${data.benchmark.kind} · 复权${data.adjustmentMethod}`),
        resultDiagnosticTable('选定数据库历史', ['份额', '名称', '起点', '终点', '观测数', '复权'], data.funds.map(f => [f.shareCode, f.shareName, f.startDate, f.endDate, f.observations, f.adjustmentMethod])));
      message.textContent = data.frozenSnapshot ? '已绑定冻结数据版本；共同区间受基准覆盖限制。' : '已绑定数据库导入版本；共同区间受基准覆盖限制。';
    } catch (error) { if (generation === sent) message.textContent = error.message; }
    finally { if (generation === sent) { profiling = false; syncButtons(); } }
  });
  freeze.addEventListener('click', async () => {
    if (loading || profiling || saving || freezing || selecting || !binding || picker.value !== baseSnapshotId) return;
    const sent = generation; freezing = true; syncButtons();
    try {
      const selection = { codes: rows.map(row => row.code), benchmarkId: controls.benchmarkId.value, sourceVersions: binding };
      const response = await fetch('/api/modules/factors/v1/snapshots/frozen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseSnapshotId, title: controls.title.value.trim(), selection }) }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '冻结失败');
      await populateSnapshotSelect(picker, baseSnapshotId);
      if (sent !== generation) return;
      picker.value = data.snapshotId;
      message.textContent = `已绑定冻结版本：${data.snapshotId}；配置尚未保存。`;
      await refreshFrozenSnapshotList?.();
    } catch (error) { if (sent === generation) message.textContent = error.message; }
    finally { freezing = false; syncButtons(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (loading || profiling || saving || freezing || selecting || !binding) return;
    const signature = () => JSON.stringify({ fields: Object.fromEntries(Object.entries(controls).filter(([key]) => key !== 'savedConfig').map(([key, field]) => [key, field.value])), notes: notes.value, shares: rows.map(r => [r.code, r.weight.value]) });
    const submittedSignature = signature();
    const shares = rows.map(r => ({ shareCode: r.code, weight: Number(r.weight.value) }));
    if (!shares.length || shares.some(r => !Number.isFinite(r.weight) || r.weight <= 0) || Math.abs(shares.reduce((n, r) => n+r.weight, 0)-1) > 1e-8) { message.textContent = '份额投入比例必须为正且合计1。'; return; }
    const configId = controls.configId.value.trim(), sent = generation, session = editSession, method = industrySaveMethod(editingId, configId);
    const strategySettings = { ...options.defaults, shares, sourceVersions: binding, startDate: controls.startDate.value, endDate: controls.endDate.value, amount: Number(controls.amount.value), frequency: controls.frequency.value, maxGapDays: Number(controls.maxGapDays.value) };
    const payload = { ...template, configId, snapshotId: picker.value, title: controls.title.value.trim(), notes: notes.value, benchmarkId: controls.benchmarkId.value, rebalanceCalendar: strategySettings.frequency, strategySettings, costModel: `subscription=${controls.subscription.value};slippage=${controls.slippage.value}` };
    saving = true; if (method === 'POST') occupiedIds.add(configId); syncButtons();
    try {
      const response = await fetch(method === 'PUT' ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(configId)}` : '/api/modules/factors/v1/experiment-configs', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await response.json();
      if (response.ok && session === editSession && controls.configId.value.trim() === configId) editingId = configId;
      if (isCurrentFundEdit(configId, sent, controls.configId.value.trim(), generation)) { message.textContent = response.ok ? signature() === submittedSignature ? `已保存：${data.item.configId} · revision ${data.item.revision}` : '提交版本已保存；当前表单还有未保存修改。' : data.errors?.join('；') || data.error; if (response.ok) editingId = configId; }
      if (response.ok) { configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json(); renderSaved(); await refreshFactorExecution?.(); }
    } catch { if (generation === sent) message.textContent = '保存失败。'; } finally { saving = false; syncButtons(); }
  });
  fill({ ...template, snapshotId: initialSnapshotId }); return panel;
}

async function strategyConfigWorkbenchPanel(library) {
  let configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
  const panel = element('section', null, 'strategy-config-workbench');
  const header = element('section', null, 'strategy-config-head');
  header.append(
    element('small', 'STRATEGY CONFIGURATION'),
    element('h2', '策略配置工作台'),
    element('p', '配置因子策略、交易标的、择时、配置、调仓和成本；保存为实验草案，不启动回测。'),
  );
  const industryFactors = library.items.filter(item => item.universe === 'sw_industry_and_etf_proxy');
  const fundFactors = library.items.filter(item => item.universe === 'public_funds');
  const saved = element('section', null, 'strategy-draft-strip');
  function refreshSaved() {
    saved.replaceChildren(element('h3', '已保存策略草案'));
    const rows = configs.items || [];
    if (!rows.length) {
      saved.append(element('p', '还没有保存的策略草案。', 'next'));
      return;
    }
    for (const item of rows.slice(-4).reverse()) {
      const card = element('article', null, 'strategy-draft-card');
      const settings = item.strategySettings || item.transactionSettings || {};
      card.append(
        element('small', item.strategyTemplateId || 'manual_strategy'),
        element('b', item.title),
        element('span', `${item.factorFamilyIds?.length || 0} 个因子 · ${item.benchmarkId || '-'} · ${settings.frequency || settings.rebalanceFrequency || item.rebalanceCalendar}`),
      );
      if (item.strategyTemplateId === 'strategy.monthly_dca_three_bucket') {
        const edit = element('button', '编辑定投配置');
        edit.type = 'button';
        edit.addEventListener('click', () => fillDcaConfig(item));
        card.append(edit);
      }
      saved.append(card);
    }
  }
  async function saveConfig(payload, messageNode) {
    const exists = configs.items?.some(item => item.configId === payload.configId);
    const url = exists ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(payload.configId)}` : '/api/modules/factors/v1/experiment-configs';
    const response = await fetch(url, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) {
      messageNode.textContent = result.errors?.join('；') || result.error || '保存失败';
      return;
    }
    messageNode.textContent = `已保存：${result.item.configId} · revision ${result.item.revision}`;
    configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
    refreshSaved();
    await refreshFactorExecution?.();
  }
  function factorWeightRows(container, factors, defaults) {
    container.replaceChildren();
    for (const item of factors) {
      const row = element('label', null, 'weight-row');
      const checked = defaults.includes(item.factorFamilyId);
      const title = element('span', item.title);
      const tag = element('small', item.category);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = item.factorFamilyId;
      checkbox.checked = checked;
      const weight = document.createElement('input');
      weight.type = 'number';
      weight.min = '0';
      weight.max = '100';
      weight.step = '5';
      weight.value = checked ? String(Math.round(100 / Math.max(1, defaults.length))) : '0';
      weight.setAttribute('aria-label', `${item.title} 权重`);
      row.append(title, tag, checkbox, weight);
      container.append(row);
    }
  }
  function selectedWeights(container) {
    return [...container.querySelectorAll('.weight-row')].map(row => {
      const checkbox = row.querySelector('input[type=checkbox]');
      const weight = row.querySelector('input[type=number]');
      return checkbox.checked ? { factorFamilyId: checkbox.value, weight: Number(weight.value || 0) / 100 } : null;
    }).filter(Boolean);
  }
  const factorForm = document.createElement('form');
  factorForm.className = 'strategy-config-card';
  factorForm.innerHTML = `
    <div class="strategy-card-title"><small>FACTOR STRATEGY</small><h3>因子策略配置</h3><p>配置因子组合、标的池、择时闸门、权重方式和调仓规则。</p></div>
    <div class="strategy-grid-form">
      <label>配置ID<input name="configId" value="config.factor_rotation_manual"></label>
      <label>标题<input name="title" value="行业因子轮动手动配置"></label>
      <label>策略类型<select name="strategyTemplateId"></select></label>
      <label>交易标的<select name="tradeInstrument"></select></label>
      <label>数据快照<select name="snapshotId"></select></label>
      <label>比较基准<select name="benchmarkId"></select></label>
      <label>Top N<input name="topN" type="number" min="1" max="20" value="3"></label>
      <label>最大持有月数<input name="holdingLimit" type="number" min="1" max="36" value="12"></label>
      <label>权重方式<select name="weightingMethod"></select></label>
      <label>调仓频率<select name="rebalanceFrequency"></select></label>
    </div>
    <section class="factor-weight-box"><h4>因子与权重</h4><div class="factor-weight-list"></div></section>
    <div class="strategy-grid-form">
      <label>择时规则<textarea name="timingRule">PE十年分位高于80%时降低权益定投强度；PMI/M2/Shibor只作为宏观提示，不单独触发交易。</textarea></label>
      <label>配置规则<textarea name="allocationRule">按标准化综合分排序，TopN等权；拥挤度作为惩罚项；不可投行业剔除。</textarea></label>
      <label>成本模型<textarea name="costModel">commission=0.00025; slippage=0.0005; annual_fee=0.006</textarea></label>
      <label>比较边界<textarea name="comparisonLimits">same_snapshot_only\nbenchmark_required\nsame_rebalance_calendar</textarea></label>
    </div>
    <section class="strategy-live-summary" aria-live="polite"></section>
    <button type="submit">保存因子策略配置</button><p class="form-message" role="status"></p>
  `;
  factorForm.elements.strategyTemplateId.append(option('strategy.factor_rotation_topn', '因子轮动 TopN'), option('strategy.fund_cross_section_screen', '基金横截面筛选'));
  factorForm.elements.tradeInstrument.append(option('industry_index_or_etf_proxy', '行业指数 / ETF代理'), option('fund_share_class', '基金份额'), option('configured_by_user', '手动指定'));
  factorForm.elements.snapshotId.append(option('snapshot.etf_smartbeta.industry_panel.current', '行业因子面板'), option('snapshot.fund_warehouse.wide_today.current', '基金宽表'));
  factorForm.elements.benchmarkId.append(option('factors.etf_smartbeta.bench', 'ETF Smart Beta 基准'), option('fund_mapped_benchmark', '基金映射基准'));
  factorForm.elements.weightingMethod.append(option('equal_weight', '等权'), option('score_weighted', '按因子分加权'), option('risk_budget', '按风险预算'));
  factorForm.elements.rebalanceFrequency.append(option('monthly', '月度'), option('quarterly', '季度'), option('manual_review', '手动复核'));
  const weightList = factorForm.querySelector('.factor-weight-list');
  function updateFactorUniverse() {
    const useFunds = factorForm.elements.strategyTemplateId.value === 'strategy.fund_cross_section_screen';
    factorForm.querySelector('[type=submit]').textContent = useFunds ? '打开基金宽表配置' : '保存因子策略配置';
    factorForm.elements.tradeInstrument.value = useFunds ? 'fund_share_class' : 'industry_index_or_etf_proxy';
    factorForm.elements.snapshotId.value = useFunds ? 'snapshot.fund_warehouse.wide_today.current' : 'snapshot.etf_smartbeta.industry_panel.current';
    factorForm.elements.benchmarkId.value = useFunds ? 'fund_mapped_benchmark' : 'factors.etf_smartbeta.bench';
    factorWeightRows(weightList, useFunds ? fundFactors : industryFactors, useFunds
      ? ['library.fund.absolute_performance', 'library.fund.benchmark_relative', 'library.fund.fees_cost', 'library.fund.manager_product_structure']
      : ['library.industry.value', 'library.industry.momentum', 'library.industry.growth_quality', 'library.industry.crowding_risk']);
    updateFactorSummary();
  }
  function updateFactorSummary() {
    const weights = selectedWeights(weightList);
    factorForm.querySelector('.strategy-live-summary').replaceChildren(
      element('h4', '配置摘要'),
      element('p', `${weights.length} 个因子 · Top ${factorForm.elements.topN.value} · ${factorForm.elements.weightingMethod.selectedOptions[0].textContent} · ${factorForm.elements.rebalanceFrequency.selectedOptions[0].textContent}`),
      element('p', `标的：${factorForm.elements.tradeInstrument.selectedOptions[0].textContent} · 基准：${factorForm.elements.benchmarkId.selectedOptions[0].textContent}`, 'next'),
    );
  }
  factorForm.addEventListener('input', updateFactorSummary);
  factorForm.elements.strategyTemplateId.addEventListener('change', updateFactorUniverse);
  weightList.addEventListener('input', updateFactorSummary);
  factorForm.addEventListener('submit', event => {
    event.preventDefault();
    if (factorForm.elements.strategyTemplateId.value === 'strategy.fund_cross_section_screen') {
      const target = document.getElementById('fund-screen-config');
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target?.querySelector('[name=title]')?.focus({ preventScroll: true });
      return;
    }
    const weights = selectedWeights(weightList);
    const payload = {
      configId: formValue(factorForm, 'configId'),
      title: formValue(factorForm, 'title'),
      strategyTemplateId: formValue(factorForm, 'strategyTemplateId'),
      snapshotId: formValue(factorForm, 'snapshotId'),
      factorFamilyIds: weights.map(item => item.factorFamilyId),
      benchmarkId: formValue(factorForm, 'benchmarkId'),
      universe: formValue(factorForm, 'strategyTemplateId') === 'strategy.fund_cross_section_screen' ? 'public_funds' : 'sw_industry_and_etf_proxy',
      portfolioRule: `${formValue(factorForm, 'allocationRule')} TopN=${formValue(factorForm, 'topN')}; weighting=${formValue(factorForm, 'weightingMethod')}`,
      rebalanceCalendar: formValue(factorForm, 'rebalanceFrequency'),
      costModel: formValue(factorForm, 'costModel'),
      constraints: ['manual_frontend_config', `tradeInstrument=${formValue(factorForm, 'tradeInstrument')}`, `holdingLimitMonths=${formValue(factorForm, 'holdingLimit')}`],
      comparisonLimits: splitList(formValue(factorForm, 'comparisonLimits')),
      factorWeights: weights,
      strategySettings: {
        tradeInstrument: formValue(factorForm, 'tradeInstrument'),
        topN: Number(formValue(factorForm, 'topN')),
        holdingLimitMonths: Number(formValue(factorForm, 'holdingLimit')),
        weightingMethod: formValue(factorForm, 'weightingMethod'),
        rebalanceFrequency: formValue(factorForm, 'rebalanceFrequency'),
        timingRule: formValue(factorForm, 'timingRule'),
        allocationRule: formValue(factorForm, 'allocationRule'),
      },
      notes: '由策略配置工作台保存；当前不运行回测。',
    };
    saveConfig(payload, factorForm.querySelector('.form-message'));
  });
  const dcaForm = document.createElement('form');
  dcaForm.className = 'strategy-config-card';
  dcaForm.innerHTML = `
    <div class="strategy-card-title"><small>TRANSACTION STRATEGY</small><h3>定投交易策略配置</h3></div>
    <div class="strategy-grid-form">
      <label>配置ID<input name="configId" value="config.monthly_dca_manual"></label>
      <label>标题<input name="title" value="宽基固定定投配置"></label>
      <label>开始日期<input name="startDate" type="date" value="2016-01-04" required></label>
      <label>结束日期<input name="endDate" type="date" value="2026-07-31" required></label>
      <label>频率<select name="frequency"></select></label>
      <label>每期金额<input name="amount" type="number" min="1" step="1" value="10000" required></label>
      <label>交易标的<select name="targetId"></select></label>
      <label>业绩基准<select name="benchmarkId"></select></label>
      <label>数据版本<select name="snapshotId" required></select></label>
      <label>现金分档<select name="cashBucketPolicy"></select></label>
    </div>
    <section class="bucket-grid">
      <label><span>A档 沪深300比例</span><input name="bucketA" type="range" min="0" max="100" value="60"><b></b></label>
      <label><span>B档 中证1000比例</span><input name="bucketB" type="range" min="0" max="100" value="25"><b></b></label>
      <label><span>C档 现金比例</span><input name="bucketC" type="range" min="0" max="100" value="15"><b></b></label>
    </section>
    <div class="strategy-grid-form">
      <label>交易规则<select name="executionRule"></select></label>
      <label>单边佣金<input name="commission" type="number" min="0" max="0.99" step="0.00001" value="0.00025" required></label>
      <label>单边滑点<input name="slippage" type="number" min="0" max="0.99" step="0.00001" value="0.0005" required></label>
      <label>宽基年费率<input name="broadFee" type="number" min="0" max="0.99" step="0.0001" value="0.0015" required></label>
      <label>研究备注<textarea name="researchNotes"></textarea></label>
    </div>
    <section class="strategy-live-summary" aria-live="polite"></section>
    <button type="submit">保存定投交易策略</button><p class="form-message" role="status"></p>
  `;
  dcaForm.elements.frequency.append(option('monthly', '月度'), option('biweekly', '双周'), option('weekly', '周度'), option('manual', '手动'));
  dcaForm.elements.benchmarkId.append(option('hs300_total_return', '沪深300全收益'), option('zz1000_total_return', '中证1000全收益'), option('factors.etf_smartbeta.bench', '旧ETF Smart Beta基准（待迁移）'));
  dcaForm.elements.targetId.append(option('hs300_total_return', '沪深300全收益代理'), option('zz1000_total_return', '中证1000全收益代理'));
  dcaForm.elements.cashBucketPolicy.append(option('broad_only', '单一宽基'), option('broad_split_cash', '沪深300 / 中证1000 / 现金'), option('bucket_a_b_c', '旧行业 / 宏观三档（待迁移）'), option('custom_bucket', '旧自定义分档（待迁移）'));
  dcaForm.elements.executionRule.append(option('fixed_contribution_hold', '固定定投，持续持有，无卖出或再平衡'), option('legacy_rules', '旧自定义规则（待迁移）'));
  await populateSnapshotSelect(dcaForm.elements.snapshotId, 'snapshot.etf_smartbeta.broad_panel.current');
  refreshDcaSnapshotChoices = async () => { if (panel.isConnected) await populateSnapshotSelect(dcaForm.elements.snapshotId, 'snapshot.etf_smartbeta.broad_panel.current'); };
  function fillDcaConfig(item) {
    const settings = item.transactionSettings || {};
    for (const key of ['configId', 'title', 'benchmarkId']) dcaForm.elements[key].value = item[key] || '';
    const snapshotId = item.snapshotId || 'snapshot.etf_smartbeta.broad_panel.current';
    if (![...dcaForm.elements.snapshotId.options].some(option => option.value === snapshotId)) dcaForm.elements.snapshotId.append(option(snapshotId, `原配置版本：${snapshotId}`));
    dcaForm.elements.snapshotId.value = snapshotId;
    for (const key of ['startDate', 'endDate', 'frequency', 'amount', 'cashBucketPolicy']) if (settings[key] !== undefined) dcaForm.elements[key].value = settings[key];
    dcaForm.elements.targetId.value = settings.targetId || 'hs300_total_return';
    dcaForm.elements.executionRule.value = settings.executionRule || 'legacy_rules';
    ['A', 'B', 'C'].forEach(key => { dcaForm.elements[`bucket${key}`].value = (settings.bucket?.[key] ?? 0) * 100; });
    const rates = Object.fromEntries((item.costModel || '').split(';').map(part => part.trim().split('=')));
    dcaForm.elements.commission.value = rates.commission || 0;
    dcaForm.elements.slippage.value = rates.slippage || 0;
    dcaForm.elements.broadFee.value = rates.broad_fee || rates.annual_fee || 0;
    dcaForm.elements.researchNotes.value = [item.notes, settings.buyRule, settings.pauseRule, settings.sellRule].filter(Boolean).join('\n');
    dcaForm.querySelector('.form-message').textContent = `编辑：${item.configId} · revision ${item.revision}`;
    updateDcaSummary();
    dcaForm.scrollIntoView({ block: 'start' });
  }
  function updateDcaSummary() {
    for (const name of ['bucketA', 'bucketB', 'bucketC']) dcaForm.elements[name].nextElementSibling.textContent = `${dcaForm.elements[name].value}%`;
    const total = ['bucketA', 'bucketB', 'bucketC'].reduce((sum, name) => sum + Number(dcaForm.elements[name].value), 0);
    const policy = dcaForm.elements.cashBucketPolicy.value;
    const supported = ['broad_only', 'broad_split_cash'].includes(policy) && dcaForm.elements.executionRule.value === 'fixed_contribution_hold' && dcaForm.elements.frequency.value !== 'manual' && dcaForm.elements.benchmarkId.value !== 'factors.etf_smartbeta.bench';
    const labels = policy === 'bucket_a_b_c' ? ['A档 宽基比例', 'B档 行业轮动比例', 'C档 宏观/基差比例'] : ['A档 沪深300比例', 'B档 中证1000比例', 'C档 现金比例'];
    ['bucketA', 'bucketB', 'bucketC'].forEach((name, index) => {
      dcaForm.elements[name].disabled = policy === 'broad_only';
      dcaForm.elements[name].parentElement.querySelector('span').textContent = labels[index];
    });
    dcaForm.elements.targetId.disabled = policy !== 'broad_only';
    dcaForm.querySelector('.strategy-live-summary').replaceChildren(
      element('h4', '交易摘要'),
      element('p', `${dcaForm.elements.frequency.selectedOptions[0].textContent} · 每期 ${money(dcaForm.elements.amount.value)} · ${dcaForm.elements.startDate.value} 到 ${dcaForm.elements.endDate.value}`),
      element('p', policy === 'broad_only' ? `单一标的：${dcaForm.elements.targetId.selectedOptions[0]?.textContent || ''}` : `资金分档合计 ${total}% · ${total === 100 ? '比例完整' : '需要调到100%'}`, policy === 'broad_only' || total === 100 ? 'ok' : 'warning'),
      element('p', supported ? '可使用宽基定投执行器' : '含有尚未接入计算的规则，仅可保存草案', supported ? 'ok' : 'warning'),
    );
  }
  dcaForm.addEventListener('input', updateDcaSummary);
  dcaForm.addEventListener('submit', event => {
    event.preventDefault();
    const bucket = {
      A: Number(formValue(dcaForm, 'bucketA')) / 100,
      B: Number(formValue(dcaForm, 'bucketB')) / 100,
      C: Number(formValue(dcaForm, 'bucketC')) / 100,
    };
    const payload = {
      configId: formValue(dcaForm, 'configId'),
      title: formValue(dcaForm, 'title'),
      strategyTemplateId: 'strategy.monthly_dca_three_bucket',
      snapshotId: formValue(dcaForm, 'snapshotId'),
      factorFamilyIds: [],
      benchmarkId: formValue(dcaForm, 'benchmarkId'),
      universe: 'broad_index_or_industry_proxy',
      portfolioRule: `cash_flow_bucket_a_b_c; A=${bucket.A}; B=${bucket.B}; C=${bucket.C}`,
      rebalanceCalendar: formValue(dcaForm, 'frequency'),
      costModel: `commission=${formValue(dcaForm, 'commission')}; slippage=${formValue(dcaForm, 'slippage')}; broad_fee=${formValue(dcaForm, 'broadFee')}`,
      constraints: ['manual_frontend_config', 'cash_flow_strategy', `cashBucketPolicy=${formValue(dcaForm, 'cashBucketPolicy')}`],
      comparisonLimits: ['cash_flow_policy_required', 'twr_and_irr_must_be_separated', 'same_benchmark_required'],
      transactionSettings: {
        startDate: formValue(dcaForm, 'startDate'),
        endDate: formValue(dcaForm, 'endDate'),
        frequency: formValue(dcaForm, 'frequency'),
        amount: Number(formValue(dcaForm, 'amount')),
        cashBucketPolicy: formValue(dcaForm, 'cashBucketPolicy'),
        bucket,
        targetId: formValue(dcaForm, 'targetId'),
        executionRule: formValue(dcaForm, 'executionRule'),
      },
      notes: formValue(dcaForm, 'researchNotes'),
    };
    saveConfig(payload, dcaForm.querySelector('.form-message'));
  });
  updateFactorUniverse();
  updateDcaSummary();
  const cards = element('section', null, 'strategy-config-grid');
  cards.append(factorForm, dcaForm);
  refreshSaved();
  panel.append(header, cards, saved);
  return panel;
}
async function fundScreenWorkbenchPanel() {
  const response = await fetch('/api/modules/factors/v1/fund-screen/options');
  let bindings = await response.json();
  const panel = element('section', null, 'fund-screen-workbench');
  panel.id = 'fund-screen-config';
  panel.append(element('h2', '基金宽表筛选配置'));
  if (!response.ok) { panel.append(element('p', bindings.error || '当前原文件不可用，请选择已冻结版本。', 'warning')); bindings = { fields: [] }; }
  let configs = (await (await fetch('/api/modules/factors/v1/experiment-configs')).json()).items || [];
  let profile = null;
  let loaded = null;
  let sourceGeneration = 0;
  const form = document.createElement('form');
  form.className = 'fund-screen-form';
  form.innerHTML = `
    <div class="strategy-grid-form">
      <label>已保存筛选草案<select name="savedConfig"></select></label>
      <label>配置ID<input name="configId" required pattern="config\\.[a-z0-9_.-]+" value="config.fund_screen"></label>
      <label>配置标题<input name="title" required value="基金同组因子筛选"></label>
      <label>数据版本<select name="snapshotId" required></select></label>
      <label>比较组<select name="group" required disabled><option value="">尚未读取宽表分类</option></select></label>
      <label>候选数量<input name="topN" type="number" min="1" max="100" step="1" value="10" required></label>
      <label>最短净值数据历史（年）<input name="minHistoryYears" type="number" min="0" step="0.1" value="0" required></label>
      <label>缺失值处理<select name="missingValuePolicy"><option value="exclude">排除任一排序字段缺失的样本</option><option value="neutral">缺失字段记中性分0.5</option></select></label>
      <label class="fund-primary-toggle"><input name="primaryShareOnly" type="checkbox" checked>仅主份额，按基金去重</label>
      <label>研究备注<textarea name="notes"></textarea></label>
    </div>
    <button type="button" class="fund-profile-action">读取宽表分组</button>
    <p class="fund-source-status" role="status">源文件：wide_today.csv · 最新横截面，非历史时点数据</p>
    <h3>排序字段与权重</h3>
    <div class="fund-rank-fields"></div>
    <button type="submit">保存筛选配置</button>
    <button type="button" class="fund-metadata-save" disabled>仅保存标题与备注</button>
    <p class="form-message" role="status"></p>
  `;
  const fieldRows = [];
  const defaults = new Set(['年化收益_pct', '成立来最大回撤_pct', '夏普_成立来']);
  const dictionary = document.createElement('details');
  function renderBindings(specs) {
  fieldRows.splice(0); form.querySelector('.fund-rank-fields').replaceChildren(); dictionary.replaceChildren(element('summary', `完整字段绑定库 · ${bindings.fields.length}项`));
  for (const field of bindings.fields.filter(item => item.rankable)) {
    const row = element('div', null, 'fund-rank-row');
    const label = document.createElement('label');
    const check = document.createElement('input');
    const spec = specs?.find(item => item.factorFamilyId === field.factorFamilyId && item.field === field.field);
    check.type = 'checkbox'; check.checked = specs ? Boolean(spec) : defaults.has(field.field);
    label.append(check, document.createTextNode(`${field.name} · ${field.familyTitle}`));
    const weight = document.createElement('input');
    weight.type = 'number'; weight.min = '0.001'; weight.step = 'any'; weight.value = spec?.weight || '1';
    weight.setAttribute('aria-label', `${field.name}权重`);
    row.append(label, element('small', `${field.sourceField} · ${field.direction === 'higher_is_better' ? '高优先' : '低优先'}`), weight);
    form.querySelector('.fund-rank-fields').append(row);
    fieldRows.push({ field, check, weight });
  }
  for (const field of bindings.fields) {
    const row = element('div', null, 'fund-binding-row');
    row.append(element('b', `${field.familyTitle} / ${field.name}`), element('small', `${field.field} → ${field.sourceField} · ${field.rankable ? '可排序' : field.available ? '仅上下文字段' : '宽表缺失'} · ${field.familyVersion}`), element('p', field.formula || '-'), element('small', `方向：${field.direction} · 缺失定义：${field.missingValuePolicy || '-'}`));
    dictionary.append(row);
  }
  }
  renderBindings();
  const message = form.querySelector('.form-message');
  const metadataSave = form.querySelector('.fund-metadata-save');
  let metadataSaving = false;
  metadataSave.addEventListener('click', async () => {
    const sentConfigId = loaded?.configId;
    const sentGeneration = sourceGeneration;
    metadataSaving = true; metadataSave.disabled = true;
    try {
      const payload = fundMetadataEditPayload(loaded, { title: formValue(form, 'title'), notes: formValue(form, 'notes') });
      const response = await fetch(`/api/modules/factors/v1/experiment-configs/${encodeURIComponent(loaded.configId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '保存失败');
      configs = (await (await fetch('/api/modules/factors/v1/experiment-configs')).json()).items;
      if (isCurrentFundEdit(sentConfigId, sentGeneration, loaded?.configId, sourceGeneration)) {
        loaded = value.item;
        message.textContent = `已仅保存标题与备注：revision ${loaded.revision}；因子、参数与数据版本保留原绑定。`;
      }
      fillSaved();
      await refreshFactorExecution?.();
    } catch (error) { if (isCurrentFundEdit(sentConfigId, sentGeneration, loaded?.configId, sourceGeneration)) message.textContent = error.message; }
    finally { metadataSaving = false; metadataSave.disabled = !loaded; }
  });
  await populateSnapshotSelect(form.elements.snapshotId, 'snapshot.fund_warehouse.wide_today.current');
  refreshFundSnapshotChoices = async () => { if (panel.isConnected) await populateSnapshotSelect(form.elements.snapshotId, 'snapshot.fund_warehouse.wide_today.current'); };
  async function changeSource(specs) {
    const generation = ++sourceGeneration;
    profile = null; form.elements.group.replaceChildren(option('', '尚未读取此版本分组')); form.elements.group.disabled = true;
    form.querySelector('.fund-profile-action').disabled = true;
    form.querySelector('.fund-source-status').textContent = `数据版本：${form.elements.snapshotId.value}`;
    try {
      const response = await fetch(`/api/modules/factors/v1/fund-screen/options?snapshotId=${encodeURIComponent(form.elements.snapshotId.value)}`);
      const value = await response.json(); if (generation !== sourceGeneration) return;
      if (!response.ok) throw new Error(value.error || '版本字段读取失败');
      bindings = value; renderBindings(specs);
      message.textContent = specs?.some(spec => !fieldRows.some(row => row.field.factorFamilyId === spec.factorFamilyId && row.field.field === spec.field)) ? '部分原配置字段在此版本中不可用；保存仅保留当前勾选字段，请复核。' : '版本已切换，请重新读取分组。';
      form.querySelector('.fund-profile-action').disabled = false;
    } catch (error) { if (generation === sourceGeneration) { message.textContent = error.message; bindings = { fields: [] }; renderBindings([]); } }
  }
  form.elements.snapshotId.addEventListener('change', () => changeSource(fieldRows.filter(row => row.check.checked).map(row => ({ factorFamilyId: row.field.factorFamilyId, field: row.field.field, weight: Number(row.weight.value) }))));
  function groupLabel(group) { return [group.strategyType, group.frequency, group.benchmark || '无基准', group.benchmarkBasis || '无基准口径'].join(' / '); }
  function fillGroups(group) {
    const select = form.elements.group;
    select.replaceChildren();
    const groups = (profile?.groups || []).filter(item => item.comparisonGroup.strategyType && item.comparisonGroup.frequency);
    groups.sort((a, b) => b.primaryCount - a.primaryCount || groupLabel(a.comparisonGroup).localeCompare(groupLabel(b.comparisonGroup)));
    groups.forEach(item => select.append(option(fundComparisonGroupValue(item.comparisonGroup), `${groupLabel(item.comparisonGroup)} · ${item.primaryCount}主份额 / ${item.rowCount}行`)));
    if (group) select.value = fundComparisonGroupValue(group);
    if (group && !select.value) select.prepend(option('', '原配置比较组已不存在，请重新选择'));
    select.disabled = !groups.length;
  }
  function fillSaved() {
    form.elements.savedConfig.replaceChildren(option('', '新建配置'));
    configs.filter(item => item.strategyTemplateId === 'strategy.fund_cross_section_screen').forEach(item => form.elements.savedConfig.append(option(item.configId, `${item.title} · revision ${item.revision}`)));
    form.elements.savedConfig.value = loaded?.configId || '';
  }
  form.elements.savedConfig.addEventListener('change', async () => {
    loaded = configs.find(item => item.configId === form.elements.savedConfig.value) || null;
    metadataSave.disabled = !loaded || metadataSaving;
    const settings = loaded?.strategySettings || {};
    form.elements.configId.value = loaded?.configId || 'config.fund_screen';
    form.elements.title.value = loaded?.title || '基金同组因子筛选';
    form.elements.topN.value = settings.topN || 10;
    form.elements.minHistoryYears.value = settings.minHistoryYears || 0;
    form.elements.missingValuePolicy.value = settings.missingValuePolicy || 'exclude';
    form.elements.primaryShareOnly.checked = settings.primaryShareOnly !== false;
    form.elements.notes.value = loaded?.notes || '';
    const snapshotId = loaded?.snapshotId || 'snapshot.fund_warehouse.wide_today.current';
    if (![...form.elements.snapshotId.options].some(item => item.value === snapshotId)) form.elements.snapshotId.append(option(snapshotId, `原配置版本：${snapshotId}`));
    form.elements.snapshotId.value = snapshotId;
    await changeSource(settings.rankFields);
  });
  form.querySelector('.fund-profile-action').addEventListener('click', async event => {
    const button = event.currentTarget;
    const generation = sourceGeneration;
    const snapshotId = form.elements.snapshotId.value;
    button.disabled = true;
    try {
      const response = await fetch(`/api/modules/factors/v1/fund-screen/profile?snapshotId=${encodeURIComponent(snapshotId)}`);
      const value = await response.json();
      if (generation !== sourceGeneration) return;
      if (!response.ok) throw new Error(value.error || '宽表分类读取失败');
      const previous = form.elements.group.value ? JSON.parse(form.elements.group.value) : loaded?.strategySettings?.comparisonGroup;
      profile = value;
      fillGroups(previous);
      form.querySelector('.fund-source-status').textContent = `${value.rowCount}行 · ${value.groupCount}个精确比较组 · SHA-256 ${value.sourceVersion.sha256}`;
      message.textContent = loaded?.strategySettings?.sourceSha256 && loaded.strategySettings.sourceSha256 !== value.sourceVersion.sha256 ? '源文件已更新；保存将绑定当前版本，旧结果仍保留原版本。' : '';
    } catch (error) { message.textContent = error.message; }
    finally { if (generation === sourceGeneration) button.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!profile || profile.snapshotId !== form.elements.snapshotId.value || !form.elements.group.value) { message.textContent = '请先读取当前版本分组并选择精确比较组。'; return; }
    const rankFields = fieldRows.filter(row => row.check.checked).map(row => ({ factorFamilyId: row.field.factorFamilyId, field: row.field.field, weight: Number(row.weight.value) }));
    if (!rankFields.length || rankFields.length > 12 || rankFields.some(item => !Number.isFinite(item.weight) || item.weight <= 0)) { message.textContent = '请选择1至12个字段，每项权重必须大于0。'; return; }
    const comparisonGroup = JSON.parse(form.elements.group.value);
    if (rankFields.some(item => item.factorFamilyId === 'library.fund.benchmark_relative') && (!comparisonGroup.benchmark || !comparisonGroup.benchmarkBasis)) { message.textContent = '基准相对因子要求明确的基准及基准口径。'; return; }
    const familyWeights = new Map();
    rankFields.forEach(item => familyWeights.set(item.factorFamilyId, (familyWeights.get(item.factorFamilyId) || 0) + item.weight));
    const payload = {
      ...loaded, configId: formValue(form, 'configId'), title: formValue(form, 'title'), strategyTemplateId: 'strategy.fund_cross_section_screen',
      snapshotId: formValue(form, 'snapshotId'), factorFamilyIds: [...familyWeights.keys()], benchmarkId: 'fund_mapped_benchmark', universe: 'public_funds',
      portfolioRule: 'single_group_weighted_field_percentile_top_n', rebalanceCalendar: 'manual_snapshot_review', costModel: 'cross_section_no_transaction_cost',
      factorWeights: [...familyWeights].map(([factorFamilyId, weight]) => ({ factorFamilyId, weight })),
      strategySettings: { comparisonGroup, sourceSha256: profile.sourceVersion.sha256, rankFields, topN: Number(form.elements.topN.value), minHistoryYears: Number(form.elements.minHistoryYears.value), missingValuePolicy: form.elements.missingValuePolicy.value, primaryShareOnly: form.elements.primaryShareOnly.checked },
      comparisonLimits: ['single_strategy_frequency_benchmark_group', 'latest_cross_section_not_point_in_time_history'], notes: formValue(form, 'notes'),
    };
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    const sentGeneration = sourceGeneration;
    try {
      const exists = configs.some(item => item.configId === payload.configId);
      const response = await fetch(`/api/modules/factors/v1/experiment-configs${exists ? `/${encodeURIComponent(payload.configId)}` : ''}`, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.errors?.join('；') || value.error || '保存失败');
      configs = (await (await fetch('/api/modules/factors/v1/experiment-configs')).json()).items;
      if (!isCurrentFundEdit(payload.configId, sentGeneration, formValue(form, 'configId'), sourceGeneration)) return;
      loaded = value.item;
      metadataSave.disabled = metadataSaving;
      fillSaved();
      message.textContent = `已保存：${loaded.configId} · revision ${loaded.revision}`;
      await refreshFactorExecution?.();
    } catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  fillSaved();
  if (!response.ok) form.querySelector('.fund-profile-action').disabled = true;
  panel.append(form, dictionary);
  return panel;
}
async function backtestToolsPanel() {
  const panel = element('section', null, 'execution-plan-panel'); panel.id = 'backtest-tools';
  panel.append(element('h2', '回测工具与 Skill'));
  const form = document.createElement('form'); form.className = 'strategy-grid-form';
  const choiceLabel = element('label', '实验配置'), choice = document.createElement('select'); choice.name = 'configId'; choiceLabel.append(choice);
  const modeLabel = element('label', '研究范围'), mode = document.createElement('select'); mode.name = 'researchMode';
  mode.append(option('assumption_simulation', '假设性模拟'), option('point_in_time_verified', '要求历史当时可见数据')); modeLabel.append(mode);
  const preflight = element('button', '预检数据与配置'); preflight.type = 'submit';
  const run = element('button', '确认并执行回测'); run.type = 'button'; run.disabled = true;
  const message = element('p', '', 'form-message'); message.setAttribute('role', 'status');
  const detail = element('section'), acknowledgement = element('section'), auditView = element('section');
  let receipt = null, generation = 0, busy = false;
  function clear() { generation += 1; receipt = null; run.disabled = true; detail.replaceChildren(); acknowledgement.replaceChildren(); auditView.replaceChildren(); }
  async function loadConfigs() {
    const response = await fetch('/api/modules/factors/v1/experiment-configs'), data = await response.json();
    if (!response.ok) throw new Error(data.error || '配置读取失败');
    const preferred = choice.value;
    choice.replaceChildren(option('', '选择已保存配置'));
    data.items.forEach(item => choice.append(option(item.configId, `${item.title} · revision ${item.revision}`)));
    choice.value = data.items.some(item => item.configId === preferred) ? preferred : '';
  }
  function sync() { run.disabled = busy || !receipt?.ready || [...acknowledgement.querySelectorAll('input')].some(input => !input.checked); }
  choice.addEventListener('change', clear); mode.addEventListener('change', clear);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !choice.value) return;
    clear(); const sent = generation; busy = true; preflight.disabled = true; sync();
    try {
      const response = await fetch('/api/modules/factors/v1/backtest-tools/preflight?' + new URLSearchParams({ configId: choice.value, researchMode: mode.value }));
      const data = await response.json(); if (sent !== generation) return;
      if (!response.ok) throw new Error(data.error || '预检失败'); receipt = data;
      message.textContent = data.ready ? `预检完成 · revision ${data.configRevision} · 仍需确认研究假设` : `已阻断：${data.blockers.join(' / ')}`;
      detail.append(element('p', `数据版本：${data.snapshotId}`), element('p', `历史信息可得性：${data.temporalEligibility.status}`));
      if (data.ready) {
        detail.append(element('p', `预检凭证：${data.preflightSha256}`));
        for (const text of data.limitations) detail.append(element('p', text, 'warning'));
        const labels = { not_point_in_time_verified: '接受未通过历史披露/修订时点验证，仅作假设性模拟', proxy_or_adjusted_nav_not_real_execution: '接受指数/复权净值代理及模拟费用，不视为真实成交或申赎结果' };
        for (const key of data.requiredAcknowledgements) {
          const label = element('label', labels[key] || key), input = document.createElement('input'); input.type = 'checkbox'; input.value = key;
          input.addEventListener('change', sync); label.prepend(input); acknowledgement.append(label);
        }
      }
    } catch (error) { if (sent === generation) message.textContent = error.message; }
    finally { busy = false; preflight.disabled = false; sync(); }
  });
  run.addEventListener('click', async () => {
    if (run.disabled || !receipt?.ready) return;
    const sent = generation, selected = receipt; busy = true; choice.disabled = mode.disabled = preflight.disabled = true; sync();
    try {
      const response = await fetch('/api/modules/factors/v1/backtest-tools/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId: selected.configId, researchMode: selected.researchMode, preflightSha256: selected.preflightSha256,
          acknowledgements: [...acknowledgement.querySelectorAll('input')].filter(input => input.checked).map(input => input.value) }) });
      const data = await response.json();
      if (sent !== generation) return;
      if (!response.ok) { clear(); throw new Error(`${data.error || '执行失败'}；请检查已有请求和结果，勿自动重试。`); }
      message.textContent = `${data.reused ? '复用已有结果' : '已生成结果'}：${data.resultArtifact.artifactId} · 审计${data.audit.status}`;
      auditView.replaceChildren(resultDiagnosticTable('结果交接审计', ['检查', '状态'], data.audit.checks.map(row => [row.checkId, row.status])), element('p', data.audit.note, 'warning'));
      receipt = null; await refreshFactorExecution?.();
    } catch (error) { receipt = null; message.textContent = error.message; }
    finally { busy = false; choice.disabled = mode.disabled = preflight.disabled = false; sync(); }
  });
  const skill = document.createElement('details'), summary = element('summary', '项目 Skill：factor-backtest');
  skill.append(summary); let loaded = false;
  skill.addEventListener('toggle', async () => {
    if (!skill.open || loaded) return; loaded = true;
    try { const response = await fetch('/api/modules/factors/v1/backtest-tools/skill'), data = await response.json(); if (!response.ok) throw new Error('Skill读取失败'); skill.append(element('pre', data.content)); }
    catch (error) { loaded = false; skill.append(element('p', error.message, 'warning')); }
  });
  form.append(choiceLabel, modeLabel, preflight); panel.append(form, message, detail, acknowledgement, run, auditView, skill);
  refreshBacktestTools = async () => { if (panel.isConnected && !busy) { clear(); await loadConfigs(); } };
  try { await loadConfigs(); } catch (error) { message.textContent = error.message; }
  return panel;
}

function factorRecordBrowser(label, renderRow) {
  const node = element('section'), controls = element('div'), list = element('div');
  const query = document.createElement('input'); query.type = 'search'; query.setAttribute('aria-label', `${label}查询`);
  const previous = element('button', '<'), next = element('button', '>'), status = element('span');
  previous.type = next.type = 'button'; previous.setAttribute('aria-label', `${label}上一页`); next.setAttribute('aria-label', `${label}下一页`);
  let records = [], offset = 0;
  function draw() {
    const term = query.value.trim().toLowerCase();
    const matches = records.filter(row => [row.title, row.configId, row.requestId, row.artifactId, row.status].some(value => String(value || '').toLowerCase().includes(term)));
    offset = Math.min(offset, Math.max(0, Math.ceil(matches.length / 10) - 1) * 10);
    list.replaceChildren(...matches.slice(offset, offset + 10).map(renderRow));
    if (!matches.length) list.append(element('p', '暂无匹配记录', 'next'));
    status.textContent = `${matches.length ? offset + 1 : 0}–${Math.min(offset + 10, matches.length)} / ${matches.length}`;
    previous.disabled = offset === 0; next.disabled = offset + 10 >= matches.length;
  }
  query.addEventListener('input', () => { offset = 0; draw(); });
  previous.addEventListener('click', () => { if (offset) { offset -= 10; draw(); } });
  next.addEventListener('click', () => { offset += 10; draw(); });
  controls.append(query, previous, status, next); node.append(controls, list);
  return { node, setItems(items) { records = items; draw(); } };
}
function downloadFactorFile(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function resultExportPanel(item) {
  const node = element('section'), buttons = element('div'), message = element('p', '', 'form-message');
  const base = item.artifactId.replace(/[^a-z0-9_.-]/gi, '_');
  const metadata = { artifactId:item.artifactId, configRevision:item.configSnapshot?.configRevision, snapshotId:item.configSnapshot?.snapshotId,
    benchmarkId:item.configSnapshot?.benchmarkId, costModel:item.configSnapshot?.costModel, effectiveCosts:effectiveCosts(item.configSnapshot),
    sourceVersions:JSON.stringify(item.dataScope?.sourceVersions || item.dataScope?.sourceVersion || null),
    preflightSha256:item.dataScope?.workflowReceipt?.preflightSha256 || null, temporalEligibility:'not_point_in_time_verified' };
  for (const [label, action] of [
    ['下载账户账本 CSV', () => {const rows=(item.accountLedger || []).map(row=>({...metadata,...row}));downloadFactorFile(csvText(rows,[...new Set(rows.flatMap(Object.keys))]),'text/csv;charset=utf-8',`${base}-ledger.csv`);} ],
    ['下载现金流 CSV', () => {const rows=(item.cashFlows || []).map(row=>({...metadata,...row}));downloadFactorFile(csvText(rows,[...new Set(rows.flatMap(Object.keys))]),'text/csv;charset=utf-8',`${base}-flows.csv`);} ],
    ['下载完整结果 JSON', () => downloadFactorFile(JSON.stringify(item,null,2),'application/json',`${base}.json`)],
  ]) { const button=element('button',label);button.type='button';button.disabled=label.includes('账本')?!item.accountLedger?.length:label.includes('现金流')?!item.cashFlows?.length:false;button.addEventListener('click',()=>{try{action();message.textContent='已生成本地下载';}catch{message.textContent='下载失败，原结果未改动';}});buttons.append(button); }
  node.append(element('h4','结果导出'),buttons,message);return node;
}
async function executionPlanPanel() {
  let plan = await (await fetch('/api/modules/factors/v1/execution-plan')).json();
  let results = await (await fetch('/api/modules/factors/v1/result-artifacts')).json();
  const panel = element('section', null, 'execution-plan-panel');
  const head = element('section', null, 'execution-head');
  head.append(
    element('small', 'BACKTEST HANDOFF'),
    element('h2', '回测执行准备区'),
    element('p', '行业TopN、宽基定投与基金同组筛选的执行记录。'),
  );
  const stages = element('section', null, 'execution-stages');
  for (const item of plan.executionStages) {
    const card = element('article', null, 'execution-stage');
    card.append(element('small', item.status), element('h3', item.title), element('p', item.gate));
    stages.append(card);
  }
  const body = element('section', null, 'execution-grid');
  const readiness = element('article', null, 'execution-card');
  const requests = element('article', null, 'execution-card');
  const resultCard = element('article', null, 'execution-card result-artifact-card');
  const resultDetail = element('article', null, 'execution-card result-detail-card wide-card');
  const comparePanel = element('section'), compared = new Map(), compareMessage = element('p', '', 'warning');
  function drawCompared() {
    const entries=[...compared.values()], series=Object.fromEntries(entries.map(item=>[item.artifactId,item.accountLedger.map(row=>({date:row.date,value:row.unitNav}))]));
    const result=compareCurves(series,entries.map(item=>item.artifactId),entries[0]?.artifactId);
    comparePanel.replaceChildren(element('h3','本次结果对比'),compareMessage);
    for(const item of entries){const remove=element('button',`移出 ${item.title}`);remove.type='button';remove.addEventListener('click',()=>{compared.delete(item.artifactId);drawCompared();});comparePanel.append(remove);}
    if(entries.length)comparePanel.append(element('p',result.period?`${result.period.join(' → ')} · 同源/成本/基准/日历的净值归一比较，非IRR排名`:`不能比较：${result.status}`),
      lineChart(result.series,{items:entries.map((item,i)=>({key:item.artifactId,name:item.title,color:['#267766','#ba4f58','#727b78','#397aaf'][i%4]}))}),
      resultDiagnosticTable('共同区间指标',['结果','归一终值','净值年化','回撤','相对首个结果'],result.items.map(row=>[row.key,fmtNum(row.finalValue,4),fmtPct(row.annualizedReturn),fmtPct(row.maxDrawdown),fmtPct(row.excessAnnualizedReturn)])));
  }
  const form = document.createElement('form');
  form.className = 'execution-card';
  let selectedResultId = results.items.at(-1)?.artifactId || null;
  let detailGeneration = 0;
  const requestBrowser = factorRecordBrowser('运行请求', item => {
      const row = element('div', null, 'request-row');
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = item.resultArtifactId ? '已生成' : '生成结果';
      action.disabled = Boolean(item.resultArtifactId) || item.requestedMode === 'guarded_backtest';
      const errorMessage = element('p', '', 'warning');
      errorMessage.setAttribute('role', 'status');
      action.addEventListener('click', async () => {
        action.textContent = '生成中'; action.disabled = true; errorMessage.textContent = '';
        try {
          const response = await fetch(`/api/modules/factors/v1/run-requests/${encodeURIComponent(item.requestId)}/execute`, { method: 'POST' });
          const result = await response.json();
          if (!response.ok) throw new Error(`执行失败：${result.error || '暂不可用'}；先核对版本和已存结果。`);
          plan = await (await fetch('/api/modules/factors/v1/execution-plan')).json();
          results = await (await fetch('/api/modules/factors/v1/result-artifacts')).json();
          selectedResultId = result.resultArtifact.artifactId;
          renderReadiness(); renderRequests(); renderResults(); await renderResultDetail();
        } catch (error) {
          action.textContent = '核对后执行'; action.disabled = false; errorMessage.textContent = error.message;
        }
      });
      row.append(element('span', item.title), action, element('small', `${item.configId} · ${item.requestId} · ${item.status}`), errorMessage);
      return row;
  });
  const resultBrowser = factorRecordBrowser('结果资产', item => {
      const row = element('div', null, 'result-row'), select = document.createElement('button');
      select.type = 'button'; select.textContent = item.artifactId === selectedResultId ? '查看中' : '查看'; select.disabled = item.artifactId === selectedResultId;
      select.addEventListener('click', async () => { selectedResultId = item.artifactId; renderResults(); await renderResultDetail(); });
      row.append(element('span', item.title), select,
        element('b', item.artifactType === 'fund_cross_section_screen' ? `${item.metrics.selectedCount}个候选` : fmtPct(item.metrics.excessAnnualizedReturn ?? item.metrics.excessIrr)),
        element('small', `${item.artifactId} · ${item.status}`));
      const compare = element('button','加入对比');compare.type='button';compare.disabled=item.artifactType==='fund_cross_section_screen';
      compare.addEventListener('click',async()=>{
        compare.disabled=true;
        try {
          const response=await fetch(`/api/modules/factors/v1/result-artifacts/${encodeURIComponent(item.artifactId)}`),payload=await response.json();
          if(!response.ok)throw new Error(payload.error||'读取失败');
          const key=resultComparisonKey(payload.item),first=[...compared.values()][0];
          if(!key||first&&key!==resultComparisonKey(first))throw new Error('结果数据版本、基准、成本、日历或投入规则不一致，不能合并比较');
          if(compared.size>=4&&!compared.has(item.artifactId))throw new Error('本次最多比较4个结果');
          compared.set(item.artifactId,payload.item);compareMessage.textContent='';drawCompared();
        }catch(error){compareMessage.textContent=error.message;}finally{compare.disabled=false;}
      });row.append(compare);
      return row;
  });
  function renderReadiness() {
    readiness.replaceChildren(element('h3', '配置草案就绪检查'));
    if (!plan.configReadiness.length) {
      readiness.append(element('p', '还没有配置草案。先在策略配置工作台保存一个因子策略或定投策略。', 'next'));
      return;
    }
    for (const item of plan.configReadiness) {
      const row = element('div', null, 'readiness-row');
      row.append(
        element('span', item.title),
        element('b', item.readyForPreflight ? '可预检' : '待补齐'),
        element('small', item.missing.length ? `缺少：${item.missing.join(' / ')}` : `配置：${item.configId}`),
      );
      readiness.append(row);
    }
  }
  function renderRequests() {
    requests.replaceChildren(element('h3', '运行请求记录'), requestBrowser.node);
    requestBrowser.setItems(plan.runRequests.slice().reverse());
  }
  function renderResults() {
    resultCard.replaceChildren(element('h3', '结果资产库'), resultBrowser.node);
    if (!results.items.length) {
      selectedResultId = null;
      detailGeneration++;
      resultDetail.replaceChildren(element('h3', '结果资产详情'), element('p', '还没有可查看的结果资产。', 'next'));
    } else if (!selectedResultId || !results.items.some(item => item.artifactId === selectedResultId)) selectedResultId = results.items.at(-1).artifactId;
    resultBrowser.setItems(results.items.slice().reverse());
  }
  async function renderResultDetail() {
    const generation = ++detailGeneration, requestedId = selectedResultId;
    resultDetail.replaceChildren(element('h3', '结果资产详情'));
    if (!selectedResultId) {
      resultDetail.append(element('p', '还没有可查看的结果资产。', 'next'));
      return;
    }
    const response = await fetch(`/api/modules/factors/v1/result-artifacts/${encodeURIComponent(requestedId)}`);
    const payload = await response.json();
    if (generation !== detailGeneration || requestedId !== selectedResultId) return;
    if (!response.ok) {
      resultDetail.append(element('p', payload.error || '结果资产详情读取失败', 'warning'));
      return;
    }
    const item = payload.item;
    resultDetail.append(resultExportPanel(item));
    const computedAttribution = industryAttributionPanel(item.attribution);
    if (computedAttribution) resultDetail.append(computedAttribution);
    const cashflowAttribution = cashflowAttributionPanel(item.attribution);
    if (cashflowAttribution) resultDetail.append(cashflowAttribution);
    const riskPanel = proxyRiskPanel(item.riskModel);
    if (riskPanel) resultDetail.append(riskPanel);
    if (item.factorProgram) {
      const p = item.factorProgram;
      resultDetail.append(element('h3', `公式绑定 ${p.factorFamilyId} · r${p.revision}`), element('p', p.executionSha256),
        resultDiagnosticTable('字段映射', ['变量', '数据字段'], Object.entries(p.executionSpec.bindings)),
        resultDiagnosticTable('子因子定义', ['指标', '公式', '定义', '方向', '相对权重'], p.executionSpec.nodes.map(n => [n.id, n.expression, n.definition, n.direction, n.weight])),
        resultDiagnosticTable('执行顺序与依赖', ['指标', '依赖'], (item.formulaAudit?.evaluationOrder || []).map(id => [id, item.formulaAudit.dependencies[id].join(' / ')])));
    }
    if (item.fundNavProfile) {
      const profile = item.fundNavProfile, last = item.accountLedger.at(-1);
      resultDetail.append(element('p', `手动份额篮子 · 基准 ${profile.benchmark.id}/${profile.benchmark.kind} · 复权 ${profile.adjustmentMethod} · 可用区间 ${profile.commonStartDate} → ${profile.commonEndDate}`),
        resultDiagnosticTable('基金历史与期末构成', ['份额', '名称', '净值起点', '净值终点', '期末市值', '漂移后占比'], profile.funds.map(row => [row.shareCode, row.shareName, row.startDate, row.endDate, fmtNum(last.fundValues[row.shareCode], 2), fmtPct(last.fundValues[row.shareCode]/last.accountValue)])),
        element('p', `共同日历${item.dataScope.calendarAudit.commonDateCount}日 · 最大间隔${item.dataScope.calendarAudit.maxObservedGapDays}天 · 年化观测系数${fmtNum(item.dataScope.calendarAudit.observationsPerYear, 2)}`, 'next'));
    }
    if (item.artifactType === 'fund_cross_section_screen') {
      const screen = item.screening;
      resultDetail.append(element('p', `${item.artifactId} · 源${screen.metrics.sourceRowCount}行 / 合格${screen.metrics.eligibleCount}行 / 候选${screen.metrics.selectedCount}行`, 'next'),
        element('p', Object.values(screen.comparisonGroup).map(value => value || '未提供').join(' / ')),
        resultDiagnosticTable('候选基金', ['排名', '份额代码', '基金名称', '综合分', '数据起点', '数据终点'], screen.candidates.map(row => [row.rank, row.shareCode, row.shareName, fmtNum(row.score, 4), row.dataStart, row.dataEnd])),
        resultDiagnosticTable('筛选审计', ['步骤', '之前', '之后', '剔除'], screen.filterAudit.map(row => [row.filter, row.before, row.after, row.excluded])),
        resultDiagnosticTable('缺失审计（缺失策略应用前）', ['字段', '缺失数量'], Object.entries(screen.missingCounts)));
      const candidate = document.createElement('select');
      candidate.setAttribute('aria-label', '候选基金因子明细');
      screen.candidates.forEach(row => candidate.append(option(row.shareCode, `${row.shareCode} ${row.shareName}`)));
      const details = element('div');
      const draw = () => {
        const selected = screen.candidates.find(row => row.shareCode === candidate.value);
        details.replaceChildren(resultDiagnosticTable('因子得分明细', ['因子', '源字段', '原值', '方向', '得分', '权重', '贡献', '缺失'], (selected?.factorDetails || []).map(row => [row.name, row.sourceField, row.rawValue, row.direction === 'higher_is_better' ? '高优先' : '低优先', fmtNum(row.score, 4), fmtNum(row.normalizedWeight, 4), fmtNum(row.contribution, 4), row.missing ? '是' : '否'])));
      };
      candidate.addEventListener('change', draw); draw();
      resultDetail.append(candidate, details);
    } else {
    resultDetail.append(
      element('p', `${item.artifactId} · ${item.executionMode} · ${item.computePolicy}`, 'next'),
      resultMetricGrid(item.metrics),
      resultDiagnosticTable('归因诊断', ['因子', '类型', '权重', '单因子超额', '边际贡献'], (item.attribution.factorDiagnostics || []).map(row => [
        row.label || row.title || row.factorKey,
        row.kind,
        fmtPct(row.configuredWeight, 1),
        fmtPct(row.soloExcess),
        fmtPct(row.marginalContribution),
      ])),
      resultDiagnosticTable('最近持仓', ['日期', '持仓', '收益', '换手', '扣费后'], (item.holdings || []).slice(-6).reverse().map(row => [
        row.date,
        (row.names || []).join(' / '),
        fmtPct(row.grossReturn),
        fmtPct(row.turnover),
        fmtPct(row.netReturn),
      ])),
      resultDiagnosticTable('敏感度', ['案例', '状态', item.scoreHistory ? 'TWR年化' : 'IRR', '超额', '回撤', '期末', '变化 / 失败原因'], (item.sensitivity || []).map(row => [
        row.case || row.topN || row.cost || row.weightShift || 'case',
        row.status || 'legacy_export',
        fmtPct(row.irr ?? row.annualizedReturn),
        fmtPct(row.excessAnnualizedReturn ?? row.excess ?? row.excessIrr),
        fmtPct(row.mdd ?? row.maxDrawdown),
        fmtNum(row.final ?? row.finalValue, 2),
        row.error || (row.parameterChanges ? JSON.stringify(row.parameterChanges) : '-'),
      ])),
    );
    }
    if (item.series?.accountValue?.length) {
      const curves = element('section', null, 'result-account-curves');
      curves.append(element('h4', '账户与基准对比'));
      const modes = document.createElement('select');
      modes.setAttribute('aria-label', '账户曲线口径');
      modes.append(option('value', '账户价值 / 累计投入'), option('nav', '时间加权净值'), option('profit','累计简单收益（损益/投入）'), option('drawdown','净值回撤'));
      const legend = element('p', '绿色：账户 · 红色：基准 · 灰色：累计投入');
      const plot = element('div');
      function drawCurves() {
        if (['profit','drawdown'].includes(modes.value)) {
          const series=accountModeSeries(item.accountLedger || [],modes.value);
          plot.replaceChildren(chartWorkspace(series,{label:'账户派生曲线',height:260,items:[{key:'strategy',name:'账户',color:'#267766'},{key:'benchmark',name:'基准',color:'#ba4f58'}]}));
          legend.textContent=modes.value==='profit'?'损益/累计投入，非TWR或IRR；零投入留空':'按完整历史净值峰值计算回撤，不因查看区间重置峰值';return;
        }
        const nav = modes.value === 'nav';
        const items = nav ? [{ key: 'unitNav', color: '#267766' }, { key: 'benchmarkNav', color: '#ba4f58' }]
          : [{ key: 'accountValue', color: '#267766' }, { key: 'benchmarkValue', color: '#ba4f58' }, { key: 'contributed', color: '#727b78' }];
        const series = Object.fromEntries(items.map(item => [item.key, payload.item.series[item.key] || []]));
        plot.replaceChildren(chartWorkspace(series, { label:'账户曲线', items, height: 260 }));
        legend.textContent = nav ? '绿色：账户净值 · 红色：基准净值' : '绿色：账户 · 红色：基准 · 灰色：累计投入';
      }
      modes.addEventListener('change', drawCurves);
      curves.append(modes, legend, plot);
      drawCurves();
      resultDetail.append(curves);
    }
    if (item.scoreHistory?.length) {
      const dates = document.createElement('select'); dates.setAttribute('aria-label', '行业打分调仓日');
      item.scoreHistory.slice().reverse().forEach(row => dates.append(option(row.date, `${row.date} · 信号 ${row.signalDate || '无'} · ${row.eligibleCount}个合格行业`)));
      const detail = element('section');
      function drawScores() {
        const decision = item.scoreHistory.find(row => row.date === dates.value);
        detail.replaceChildren(element('p', `${decision.reason || (decision.bActive ? 'B档行业轮动' : 'B新投入转A、旧持仓保留')} · 信号日 ${decision.signalDate || '-'} · 持仓 ${(decision.holdingNames || decision.names).join(' / ') || '现金'}`),
          resultDiagnosticTable('行业综合得分', ['行业代码', '行业', '综合分', '有效加权覆盖', '入选'], decision.scores.map(row => [row.code, row.name, fmtNum(row.score, 4), fmtPct(row.coverage), decision.codes.includes(row.code) ? '是' : '否'])));
        for (const row of decision.scores.filter(row => decision.codes.includes(row.code))) {
          const slots = document.createElement('details'); slots.append(element('summary', `${row.name} · 因子贡献`), resultDiagnosticTable('因子贡献明细', ['因子族', '槽位', '原值', 'z-score', '方向', '类内权重', '类间权重', '贡献'], row.factorDetails.map(d => [d.familyId, d.field, d.rawValue, fmtNum(d.zScore, 4), d.sign, fmtPct(d.slotWeight), fmtPct(d.familyWeight), fmtNum(d.contribution, 4)]))); detail.append(slots);
        }
      }
      dates.addEventListener('change', drawScores); drawScores();
      resultDetail.append(element('h4', '行业信号与持仓审计'), dates, detail);
    }
    if (item.sleeveMetrics?.length) {
      const calendar = item.dataScope.calendarAudit;
      if (calendar) resultDetail.append(element('p', `执行日历 ${calendar.policy} · 宽基${calendar.broadDateCount}日 / 共同${calendar.executionDateCount}日 · 排除 ${calendar.excludedBroadDates.join(' / ') || '无'}`, 'next'));
      resultDetail.append(resultDiagnosticTable('三档指标（IRR不可相加）', ['分档', '有效起点', '累计投入', '期末价值', 'TWR年化', 'IRR', '最大回撤', '交易成本', '年费'], item.sleeveMetrics.map(row => [row.bucket, row.activeStartDate || '未投入', fmtNum(row.totalContributed, 2), fmtNum(row.finalValue, 2), fmtPct(row.annualizedReturn), fmtPct(row.moneyWeightedIrr), fmtPct(row.maxDrawdown), fmtNum(row.tradingCost, 2), fmtNum(row.managementFee, 2)])));
      const items = [{ key: 'bucketANav', color: '#267766' }, { key: 'bucketBNav', color: '#ba4f58' }, { key: 'bucketCNav', color: '#727b78' }];
      resultDetail.append(element('h4', '三档时间加权净值'), element('p', '绿色：A宽基 · 红色：B行业 · 灰色：C择时'), lineChart(item.series, { items, height: 260 }));
      const dates = document.createElement('select'); dates.setAttribute('aria-label', '三档决策日期');
      item.timingHistory.slice().reverse().forEach(row => dates.append(option(row.date, row.date)));
      const detail = element('section');
      function drawTiming() {
        const row = item.timingHistory.find(row => row.date === dates.value), t = row.timing;
        detail.replaceChildren(element('p', `信号日 ${row.signalDate || '无'} · B转A ${fmtNum(row.redirectBToA, 2)} · C股票比例 ${fmtPct(t.equityRatio)} · 强制退出 ${row.forcedCodes.join(' / ') || '无'}`),
          resultDiagnosticTable('A档闸门', ['标的', 'PE分位', '停投', 'PE状态', '趋势状态'], row.gates.map(g => [g.target, fmtPct(g.percentile), g.closed ? '是' : '否', g.peStatus, g.trendStatus])),
          resultDiagnosticTable('C档宏观可用性（建模日期）', ['组件', '观察月份', '建模可用日', '得分', '状态'], t.components.map(c => [c.component, c.sourceMonth, c.availableAt, fmtNum(c.score, 4), c.status])),
          element('p', `基差数据日 ${t.basisDate || '无'} · 基差分 ${fmtNum(t.basisScore, 4)} · 宏观分 ${fmtNum(t.macroScore, 4)} · ${t.basisStatus} · ${t.fallback}`));
      }
      dates.addEventListener('change', drawTiming); drawTiming();
      resultDetail.append(element('h4', '三档信号与闸门审计'), dates, detail,
        resultDiagnosticTable('三档投入分配', ['日期', '总投入', 'A', 'B', 'C'], item.cashFlows.map(row => [row.date, fmtNum(row.amount, 2), ...['A', 'B', 'C'].map(k => fmtNum(row.allocations[k], 2))])));
    }
    if (item.cashFlows?.length && !item.sleeveMetrics?.length) {
      resultDetail.append(resultDiagnosticTable('现金流明细', ['计划日期', '数据执行日期', '投入金额', '买入成本', '基准买入成本', '现金分配'], item.cashFlows.map(row => [
        row.scheduledDates.join(' / '), row.date, fmtNum(row.amount, 2), fmtNum(row.buyCost, 2), fmtNum(row.benchmarkBuyCost, 2), fmtNum(row.cashAllocation, 2),
      ])));
      if (item.pendingContributions?.length) resultDetail.append(resultDiagnosticTable('期内未能执行的计划投入', ['计划日期', '计划金额', '状态'], item.pendingContributions.map(row => [row.scheduledDate, fmtNum(row.amount, 2), '区间内无可用数据日期，未计入累计投入'])));
      resultDetail.append(resultDiagnosticTable('最近30个数据日账户账本', ['日期', '账户价值', '基准价值', '累计投入', '时间加权净值', '现金余额'], (item.accountLedger || []).slice(-30).map(row => [
        row.date, fmtNum(row.accountValue, 2), fmtNum(row.benchmarkValue, 2), fmtNum(row.contributed, 2), fmtNum(row.unitNav, 4), fmtNum(row.cash, 2),
      ])));
    }
    const checklist = element('section', null, 'result-review-list');
    checklist.append(element('h4', '复核清单'));
    for (const check of payload.reviewChecklist) {
      const row = element('div', null, 'data-row');
      row.append(element('span', check.title), element('b', check.status), element('small', check.notes));
      checklist.append(row);
    }
    const warnings = element('section', null, 'result-review-list');
    warnings.append(element('h4', '数据口径与警示'));
    for (const warning of item.warnings || []) warnings.append(element('p', warning, 'warning'));
    warnings.append(element('p', item.dataScope?.limitation || item.attribution?.explanation || '', 'next'));
    if (item.dataScope?.calculationLogic?.length) {
      warnings.append(element('h4', '计算口径'));
      item.dataScope.calculationLogic.forEach(note => warnings.append(element('p', note)));
    }
    if (item.dataScope?.sourceVersion) warnings.append(element('p', `源文件SHA-256：${item.dataScope.sourceVersion.sha256}`, 'next'));
    for (const source of item.dataScope?.sourceVersions || []) warnings.append(element('p', `${source.assetId || source.sourceId} · SHA-256：${source.sha256}`, 'next'));
    if (item.dataScope?.frozenSnapshot) warnings.append(element('p', `冻结数据：${item.dataScope.frozenSnapshot.snapshotId} · 执行前SHA校验通过 · ${item.dataScope.frozenSnapshot.createdAt}`, 'next'));
    resultDetail.append(checklist, warnings);
  }
  function resultMetricGrid(metrics) {
    const grid = element('section', null, 'result-metric-grid');
    for (const [label, value] of [
      ['TWR年化', fmtPct(metrics.annualizedReturn)],
      ['账户IRR', fmtPct(metrics.moneyWeightedIrr)],
      [metrics.benchmarkAnnualizedReturn !== undefined ? '基准TWR年化' : '基准IRR', fmtPct(metrics.benchmarkAnnualizedReturn ?? metrics.benchmarkIrr)],
      ['超额', fmtPct(metrics.excessAnnualizedReturn ?? metrics.excessIrr)],
      ['回撤', fmtPct(metrics.maxDrawdown)],
      ['波动', fmtPct(metrics.volatility)],
      ['Sharpe', fmtNum(metrics.sharpe)],
      ['换手', fmtPct(metrics.turnover)],
      ['IC', fmtNum(metrics.informationCoefficient)],
      ['期末', fmtNum(metrics.finalValue, 2)],
      ['累计投入', fmtNum(metrics.totalContributed, 2)],
      ['投入次数', fmtNum(metrics.contributionCount, 0)],
      ['总费用', fmtNum(metrics.totalCost, 2)],
    ]) {
      const card = element('div', null, 'result-metric');
      card.append(element('small', label), element('b', value));
      grid.append(card);
    }
    return grid;
  }
  function renderForm() {
    const readyConfigs = plan.configReadiness;
    form.innerHTML = `
      <h3>创建运行请求</h3>
      <label>配置草案<select name="configId"></select></label>
      <label>执行器候选<select name="artifactCandidateId"></select></label>
      <label>请求标题<input name="title" placeholder="例如：行业TopN月度回测预检"></label>
      <label>备注<textarea name="notes" placeholder="记录为什么要运行、需要关注什么误差或敏感度。"></textarea></label>
      <section class="execution-summary" aria-live="polite"></section>
      <button type="submit">保存运行请求</button>
      <p class="form-message" role="status"></p>
    `;
    const configSelect = form.elements.configId;
    for (const item of readyConfigs) configSelect.append(option(item.configId, `${item.title}${item.readyForPreflight ? '' : '（待补齐）'}`));
    const artifactSelect = form.elements.artifactCandidateId;
    for (const item of plan.engineCandidates) artifactSelect.append(option(item.artifactCandidateId, item.title));
    const updateSummary = () => {
      const selected = plan.configReadiness.find(item => item.configId === formValue(form, 'configId'));
      form.querySelector('.execution-summary').replaceChildren(
        element('h4', '预检摘要'),
        element('p', selected?.readyForPreflight ? '字段具备预检条件；保存请求后可单独执行支持的策略。' : `待补齐：${selected?.missing.join(' / ') || '无配置'}`, selected?.readyForPreflight ? 'ok' : 'warning'),
      );
    };
    form.oninput = updateSummary;
    const chooseEngine = () => {
      const selected = plan.configReadiness.find(item => item.configId === configSelect.value);
      artifactSelect.value = selected?.strategyTemplateId === 'strategy.custom_industry_expression' ? 'artifact.factor.custom_industry_expression' : selected?.strategyTemplateId === 'strategy.fund_nav_fixed_dca' ? 'artifact.factor.fund_nav_fixed_dca' : selected?.strategyTemplateId === 'strategy.legacy_three_bucket_monthly' ? 'artifact.factor.three_bucket_monthly' : selected?.strategyTemplateId === 'strategy.industry_parquet_monthly_topn' ? 'artifact.factor.industry_parquet_topn' : selected?.strategyTemplateId === 'strategy.fund_cross_section_screen' ? 'artifact.factor.fund_cross_section_screen' : 'artifact.factor.backtest.monthly_dca_engine';
      updateSummary();
    };
    configSelect.addEventListener('change', chooseEngine);
    chooseEngine();
    updateSummary();
    form.onsubmit = async event => {
      event.preventDefault();
      const response = await fetch('/api/modules/factors/v1/run-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configId: formValue(form, 'configId'),
          artifactCandidateId: formValue(form, 'artifactCandidateId'),
          title: formValue(form, 'title'),
          notes: formValue(form, 'notes'),
        }),
      });
      const result = await response.json();
      const msg = form.querySelector('.form-message');
      if (!response.ok) {
        msg.textContent = result.errors?.join('；') || result.error || '保存失败';
        return;
      }
      msg.textContent = `已记录：${result.item.requestId}`;
      plan = await (await fetch('/api/modules/factors/v1/execution-plan')).json();
      results = await (await fetch('/api/modules/factors/v1/result-artifacts')).json();
      renderReadiness();
      renderRequests();
      renderResults();
      renderResultDetail();
      renderForm();
    };
  }
  refreshFactorExecution = async () => {
    if (!panel.isConnected) return;
    plan = await (await fetch('/api/modules/factors/v1/execution-plan')).json();
    results = await (await fetch('/api/modules/factors/v1/result-artifacts')).json();
    renderReadiness(); renderRequests(); renderResults(); renderForm(); await renderResultDetail();
    await refreshBacktestTools?.();
  };
  renderReadiness();
  renderRequests();
  renderResults();
  await renderResultDetail();
  renderForm();
  drawCompared(); body.append(readiness, form, requests, resultCard, resultDetail, comparePanel);
  const notes = element('section', null, 'execution-notes');
  for (const note of plan.notes) notes.append(element('p', note));
  panel.append(head, stages, body, notes);
  return panel;
}
async function backtestEnginePanel() {
  const response = await fetch('/api/modules/factors/v1/backtest-engine');
  if (!response.ok) throw new Error('回测引擎状态暂不可用');
  const engine = await response.json();
  const panel = element('section', null, 'backtest-engine-panel');
  const head = element('section', null, 'engine-head');
  head.append(
    element('small', 'ENGINE STATUS'),
    element('h2', '回测引擎状态与迁移路线'),
    element('p', '这里说明当前结果到底由哪个引擎生成、读了什么数据、哪些口径已实现、哪些还需要在parquet或宽表层继续审计。'),
  );
  const summary = element('section', null, 'engine-summary');
  for (const item of [
    ['月份', engine.panelInput.monthCount],
    ['行业', engine.panelInput.industryCount],
    ['字段', engine.panelInput.factorFieldCount],
    ['结果资产', engine.resultStore.count],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const grid = element('section', null, 'engine-grid');
  const active = element('article', null, 'engine-card');
  active.append(
    element('h3', engine.activeEngine.title),
    element('p', engine.activeEngine.computePolicy),
    element('p', `支持：${engine.activeEngine.supportedSnapshotIds.join(' / ')}`, 'next'),
  );
  for (const calc of engine.activeEngine.calculations) active.append(element('span', calc, 'pill'));
  const future = element('article', null, 'engine-card');
  future.append(element('h3', '执行器迁移进度'));
  for (const item of engine.nextEngines) {
    const row = element('div', null, 'engine-row');
    row.append(element('span', item.title), element('b', item.status), element('small', item.blockers.join(' / ')));
    future.append(row);
  }
  const audit = element('article', null, 'engine-card wide-card');
  audit.append(element('h3', '计算审计清单'));
  for (const item of engine.auditChecklist) {
    const row = element('div', null, 'engine-row');
    row.append(element('span', item.title), element('b', item.status), element('small', item.notes));
    audit.append(row);
  }
  const coverage = element('article', null, 'engine-card wide-card');
  coverage.append(element('h3', '因子字段覆盖'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>类别</th><th>类型</th><th>字段数</th><th>字段</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const item of engine.panelInput.factorCategoryCoverage) {
    const tr = document.createElement('tr');
    for (const value of [item.title, item.kind, item.slotCount, item.fields.map(field => field.name).join(' / ')]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  coverage.append(table);
  grid.append(active, future, audit, coverage);
  panel.append(head, summary, grid);
  return panel;
}
async function experimentConfigPanel(library) {
  const panel = element('section', null, 'experiment-config-panel');
  let configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
  const saved = element('section', null, 'config-list');
  const factorOptions = library.items.map(item => ({
    id: item.factorFamilyId,
    title: item.title,
    category: item.category,
    universe: item.universe,
  }));
  const snapshotOptions = [...new Set(library.items.flatMap(item => item.snapshotIds || []))].sort();
  const universeOptions = [...new Set(library.items.map(item => item.universe).filter(Boolean))].sort();
  const benchmarkOptions = [...new Set([...(configs.templates || []).map(item => item.benchmarkId), 'fund_mapped_benchmark'].filter(Boolean))].sort();
  const form = document.createElement('form');
  form.className = 'factor-form config-form';
  form.innerHTML = `
    <h2>实验配置工具</h2>
    <p>保存实验口径，不启动回测。配置会写入本地草案库，后续回测工具和Skill读取这里。</p>
    <datalist id="snapshot-options">${snapshotOptions.map(item => `<option value="${item}"></option>`).join('')}</datalist>
    <datalist id="benchmark-options">${benchmarkOptions.map(item => `<option value="${item}"></option>`).join('')}</datalist>
    <datalist id="universe-options">${universeOptions.map(item => `<option value="${item}"></option>`).join('')}</datalist>
    <div class="form-grid">
      <label>配置 ID<input name="configId" placeholder="config.industry_value_mom_v1"></label>
      <label>标题<input name="title" required placeholder="行业价值+动量月度Top3"></label>
      <label>Snapshot<input name="snapshotId" required list="snapshot-options" placeholder="snapshot.etf_smartbeta.industry_panel.current"></label>
      <label>因子族 IDs<input name="factorFamilyIds" required placeholder="library.industry.value, library.industry.momentum"></label>
      <label>基准<input name="benchmarkId" required list="benchmark-options" placeholder="factors.etf_smartbeta.bench"></label>
      <label>适用范围<input name="universe" list="universe-options" placeholder="sw_industry_and_etf_proxy / public_funds"></label>
    </div>
    <fieldset class="factor-picker">
      <legend>选择因子族</legend>
      <p>勾选后会自动写入“因子族 IDs”；也可以直接手动编辑 IDs。</p>
    </fieldset>
    <label>组合规则<textarea name="portfolioRule" required placeholder="例如：每月调仓，综合分Top3等权；不可投行业剔除。"></textarea></label>
    <label>调仓日历<textarea name="rebalanceCalendar" required placeholder="例如：每月首个交易日；基金横截面为月度刷新后手动。"></textarea></label>
    <label>成本模型<textarea name="costModel" required placeholder="例如：commission=0.00025; slippage=0.0005; annual_fee=0.006"></textarea></label>
    <label>约束<textarea name="constraints" placeholder="每行或逗号分隔：top_n_required, same_snapshot_only"></textarea></label>
    <label>比较边界<textarea name="comparisonLimits" placeholder="每行或逗号分隔：不同snapshot不可直接比较"></textarea></label>
    <label>备注<textarea name="notes" placeholder="记录这个配置为什么存在、适合验证什么问题、有什么风险。"></textarea></label>
    <section class="config-summary" aria-live="polite"></section>
    <div class="form-actions"><button type="submit">保存配置草案</button><button type="button" name="clearConfig">清空</button></div>
    <p class="form-message" role="status"></p>
  `;
  const picker = form.querySelector('.factor-picker');
  for (const item of factorOptions) {
    const label = element('label', null, 'factor-choice');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = item.id;
    label.append(input, element('span', `${item.title} · ${item.category}`), element('small', item.universe));
    picker.append(label);
  }
  function selectedFactorIds() {
    return splitList(formValue(form, 'factorFamilyIds'));
  }
  function syncPickerFromInput() {
    const selected = new Set(selectedFactorIds());
    for (const input of picker.querySelectorAll('input[type=checkbox]')) input.checked = selected.has(input.value);
    updateConfigSummary();
  }
  function syncInputFromPicker() {
    const selected = [...picker.querySelectorAll('input[type=checkbox]:checked')].map(input => input.value);
    form.elements.factorFamilyIds.value = selected.join(', ');
    updateConfigSummary();
  }
  function updateConfigSummary() {
    const selected = selectedFactorIds();
    const selectedDetails = selected.map(id => factorOptions.find(item => item.id === id)).filter(Boolean);
    const universes = [...new Set(selectedDetails.map(item => item.universe).filter(Boolean))];
    const constraints = splitList(formValue(form, 'constraints'));
    const limits = splitList(formValue(form, 'comparisonLimits'));
    const warnings = [];
    if (!formValue(form, 'snapshotId')) warnings.push('需要指定数据快照');
    if (!selected.length) warnings.push('至少选择一个因子族');
    if (!formValue(form, 'benchmarkId')) warnings.push('需要指定比较基准');
    if (universes.length > 1) warnings.push(`因子适用范围混用：${universes.join(' / ')}`);
    const summary = [
      `${selected.length} 个因子族`,
      formValue(form, 'snapshotId') || '未选快照',
      formValue(form, 'benchmarkId') || '未选基准',
      `约束 ${constraints.length}`,
      `比较边界 ${limits.length}`,
      '保存配置，不启动回测',
    ];
    form.querySelector('.config-summary').replaceChildren(
      element('h3', '配置摘要'),
      element('p', summary.join(' · ')),
      element('p', warnings.length ? `待补齐：${warnings.join('；')}` : '口径字段已具备保存条件。', warnings.length ? 'warning' : 'ok'),
    );
  }
  function fillConfig(item) {
    form.elements.configId.value = item.configId || '';
    form.elements.title.value = item.title || '';
    form.elements.snapshotId.value = item.snapshotId || '';
    form.elements.factorFamilyIds.value = (item.factorFamilyIds || []).join(', ');
    form.elements.benchmarkId.value = item.benchmarkId || '';
    form.elements.universe.value = item.universe || '';
    form.elements.portfolioRule.value = item.portfolioRule || '';
    form.elements.rebalanceCalendar.value = item.rebalanceCalendar || '';
    form.elements.costModel.value = item.costModel || '';
    form.elements.constraints.value = (item.constraints || []).join('\n');
    form.elements.comparisonLimits.value = (item.comparisonLimits || []).join('\n');
    form.elements.notes.value = item.notes || '';
    form.querySelector('.form-message').textContent = item.configId ? '正在修改配置草案。' : '';
    syncPickerFromInput();
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderConfigs() {
    saved.replaceChildren(element('h2', '配置模板与草案'));
    const rows = [...(configs.templates || []), ...(configs.items || [])];
    for (const item of rows) {
      const card = element('article', null, 'factor-card');
      const isDraft = Boolean(item.configId);
      const id = item.configId || item.templateId;
      card.append(
        element('small', isDraft ? `草案 · ${item.status || 'draft'}` : '模板'),
        element('h3', item.title),
        element('p', `Snapshot：${item.snapshotId || '-'} · 基准：${item.benchmarkId || '-'}`),
        element('p', item.portfolioRule || '', 'factor-fields'),
      );
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = isDraft ? '修改' : '套用模板';
      button.addEventListener('click', () => item.strategyTemplateId === 'strategy.custom_industry_expression' ? editExpressionConfig?.({ configId: isDraft ? item.configId : '' }) : item.strategyTemplateId === 'strategy.fund_nav_fixed_dca' ? editFundNavConfig?.({ configId: isDraft ? item.configId : '' }) : item.strategyTemplateId === 'strategy.legacy_three_bucket_monthly' ? editThreeBucketConfig?.({ configId: isDraft ? item.configId : '' }) : item.strategyTemplateId === 'strategy.industry_parquet_monthly_topn' ? editIndustryConfig?.({ ...item, configId: isDraft ? item.configId : '' }) : fillConfig({ ...item, configId: isDraft ? item.configId : '' }));
      card.append(button);
      saved.append(card);
    }
    if (!configs.items?.length) saved.append(element('p', '还没有保存的配置草案。', 'next'));
  }
  picker.addEventListener('change', syncInputFromPicker);
  for (const name of ['snapshotId', 'factorFamilyIds', 'benchmarkId', 'universe', 'constraints', 'comparisonLimits']) {
    form.elements[name].addEventListener('input', name === 'factorFamilyIds' ? syncPickerFromInput : updateConfigSummary);
  }
  form.elements.clearConfig.addEventListener('click', () => {
    form.reset();
    form.querySelector('.form-message').textContent = '';
    syncPickerFromInput();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    updateConfigSummary();
    const id = formValue(form, 'configId');
    const payload = {
      configId: id,
      title: formValue(form, 'title'),
      snapshotId: formValue(form, 'snapshotId'),
      factorFamilyIds: splitList(formValue(form, 'factorFamilyIds')),
      benchmarkId: formValue(form, 'benchmarkId'),
      universe: formValue(form, 'universe'),
      portfolioRule: formValue(form, 'portfolioRule'),
      rebalanceCalendar: formValue(form, 'rebalanceCalendar'),
      costModel: formValue(form, 'costModel'),
      constraints: splitList(formValue(form, 'constraints')),
      comparisonLimits: splitList(formValue(form, 'comparisonLimits')),
      notes: formValue(form, 'notes'),
    };
    const exists = configs.items?.some(item => item.configId === id);
    const url = exists ? `/api/modules/factors/v1/experiment-configs/${encodeURIComponent(id)}` : '/api/modules/factors/v1/experiment-configs';
    const response = await fetch(url, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    const msg = form.querySelector('.form-message');
    if (!response.ok) {
      msg.textContent = result.errors?.join('；') || result.error || '保存失败';
      return;
    }
    msg.textContent = `已保存：${result.item.configId} · revision ${result.item.revision}`;
    configs = await (await fetch('/api/modules/factors/v1/experiment-configs')).json();
    renderConfigs();
  });
  panel.append(saved, form);
  renderConfigs();
  updateConfigSummary();
  return panel;
}
async function factorLabFrameworkPanel() {
  const response = await fetch('/api/modules/factors/v1/lab-framework');
  if (!response.ok) throw new Error('因子实验室框架暂不可用');
  const framework = await response.json();
  const panel = element('section', null, 'lab-framework-panel');
  const summary = element('section', null, 'lab-summary');
  for (const item of [
    ['因子族', framework.factorCount],
    ['子因子/指标', framework.subFactorCount],
    ['已被配置引用', framework.configuredFactorCount],
    ['迁移能力块', framework.capabilityCount],
  ]) {
    const card = element('article', null, 'metric-card');
    card.append(element('small', item[0]), element('strong', String(item[1])));
    summary.append(card);
  }
  const capabilityGrid = element('section', null, 'capability-grid');
  capabilityGrid.append(element('h2', '因子实验室迁移能力框架'));
  for (const item of framework.capabilities) {
    const card = element('article', null, 'factor-card');
    card.append(
      element('small', `${item.requirementRef} · ${item.status}`),
      element('h3', item.title),
      element('p', `配置：${item.configFields.join(' / ')}`),
      element('p', `展示：${item.outputViews.join(' / ')}`, 'factor-fields'),
      element('p', item.logicNotes, 'next'),
    );
    capabilityGrid.append(card);
  }
  const inventory = element('section', null, 'inventory-list');
  inventory.append(element('h2', '因子定义、子因子与使用记录'));
  for (const item of framework.factorInventory) {
    const row = element('article', null, 'inventory-row');
    const fieldNames = item.fields.slice(0, 6).map(field => `${field.name || field.field}(${field.role})`).join(' / ');
    const uses = [
      ...(item.strategyUses || []).map(id => `策略:${id}`),
      ...(item.configUses || []).map(id => `配置:${id}`),
    ];
    row.append(
      element('small', `${item.category} · ${item.universe} · ${item.status}`),
      element('h3', item.title),
      element('p', fieldNames || '尚未登记字段'),
      element('p', uses.length ? uses.join(' · ') : '尚未被实验草案引用', uses.length ? 'ok' : 'warning'),
    );
    inventory.append(row);
  }
  const strategies = element('section', null, 'strategy-grid');
  strategies.append(element('h2', '策略配置模板'));
  for (const item of framework.strategyTemplates) {
    const card = element('article', null, 'factor-card');
    card.append(
      element('small', `${item.strategyType} · ${item.targetUniverse}`),
      element('h3', item.title),
      element('p', `交易标的：${item.tradeInstrument}`),
      element('p', `因子：${item.factorFamilyIds.length ? item.factorFamilyIds.join(' / ') : '用户自建'}`, 'factor-fields'),
      element('p', `输出：${item.outputNeeds.join(' / ')}`, 'next'),
    );
    strategies.append(card);
  }
  const views = element('section', null, 'result-view-list');
  views.append(element('h2', '回测结果、归因、误差与敏感度展示口径'));
  for (const item of framework.resultViews) {
    const row = element('article', null, 'inventory-row');
    row.append(
      element('small', item.viewId),
      element('h3', item.title),
      element('p', `指标：${item.metrics.join(' / ')}`),
      element('p', `比较维度：${item.compareBy.join(' / ')}`, 'factor-fields'),
      element('p', item.notes, 'next'),
    );
    views.append(row);
  }
  const notes = element('section', null, 'config-summary');
  notes.append(element('h3', '迁移边界'), ...framework.notes.map(note => element('p', note)));
  panel.append(
    element('p', '这里是旧因子实验室能力迁移到新工作台的列表库框架：先把配置、使用记录、展示口径和误差说明固定，再接回测引擎。', 'intro'),
    summary,
    capabilityGrid,
    inventory,
    strategies,
    views,
    notes,
  );
  return panel;
}
try {
  const response = await fetch('/api/workspaces');
  if (!response.ok) throw new Error('工作区服务暂不可用');
  const { items } = await response.json();
  for (const item of items) {
    const a = element('a', item.title);
    a.href = `#${item.id}`;
    nav.append(a);
  }
  async function render() {
    if (cleanup) cleanup();
    cleanup = null;
    refreshDcaSnapshotChoices = null; refreshFundSnapshotChoices = null; refreshIndustrySnapshotChoices = null; editIndustryConfig = null; refreshThreeBucketSnapshotChoices = null; editThreeBucketConfig = null; editFundNavConfig = null; refreshFundNavSnapshotChoices = null; refreshFrozenSnapshotList = null; refreshBacktestTools = null; editExpressionFactor = null; editExpressionConfig = null;
    const selected = items.find(item => item.id === location.hash.slice(1)) || items[0];
    for (const a of nav.children) {
      if (a.hash === `#${selected.id}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    content.replaceChildren(element('p', selected.label, 'eyebrow'), element('h1', selected.title), element('p', selected.description, 'intro'));
    const isNative = selected.status === 'native_module' && selected.href;
    if (selected.id !== 'factors') {
      const empty = element('section', null, 'empty');
      const status = isNative ? '原生模块已接入 · 本地副本' : selected.status === 'readonly_index' ? '只读索引已接入' : selected.status === 'paused_archive' ? '已暂停 · 仅保留历史入口' : '待接入';
      const title = isNative ? '继续原有研究工作' : selected.status === 'readonly_index' ? '先查看原研究生产能力' : selected.status === 'paused_archive' ? '暂停生产与默认回归' : '从可追溯的证据开始';
      const body = isNative ? '已保留原产品页面与操作。观察记录仍保存在本浏览器；服务端持久化待后续契约批次。' : selected.status === 'readonly_index' ? '已按源项目逻辑接入 Skill 注册表、工作流入口和报告产出索引；当前只读，不启动旧服务或模型任务。' : selected.status === 'paused_archive' ? '日报归档和早晚报生产先从主线移出，避免继续消耗默认检查预算；需要时仍可独立打开历史快照。' : '此模块尚待完整迁入。';
      empty.append(element('span', status, 'status'), element('h2', title), element('p', body), element('p', `下一步：${selected.next}`, 'next'));
      if (isNative) { const open=element('a','独立打开完整模块 ↗','open-module');open.href=selected.href;open.target='_blank';open.rel='noopener';empty.append(open); }
      if (selected.archiveHref) { const open=element('a','打开历史归档 ↗','open-module');open.href=selected.archiveHref;open.target='_blank';open.rel='noopener';empty.append(open); }
      content.append(empty);
    }
    if (isNative) {
      const mount = element('section', null, 'native-module');
      mount.setAttribute('aria-label', selected.title);
      content.append(mount);
      cleanup = await mountLegacyModule(mount, selected.id);
      return;
    }
    if (selected.id === 'research') content.append(await researchPanel());
    if (selected.id === 'factors') {
      const library = await (await fetch('/api/modules/factors/v1/library')).json();
      content.append(await factorVisualLabPanel());
      content.append(await legacyDcaReplayPanel());
      content.append(await experimentComparisonPanel());
      content.append(await factorProductConsolePanel());
      content.append(await factorDataLayerPanel());
      content.append(await dataQualityAuditPanel());
      content.append(await legacyExperimentLibraryPanel());
      content.append(await industryConfigPanel(library));
      content.append(await customExpressionPanel());
      content.append(await threeBucketConfigPanel(library));
      content.append(await fundNavConfigPanel());
      content.append(await strategyConfigWorkbenchPanel(library));
      content.append(await fundScreenWorkbenchPanel());
      content.append(await customFactorStudioPanel(library));
      content.append(await backtestEnginePanel());
      content.append(await backtestToolsPanel());
      content.append(await executionPlanPanel());
      content.append(await factorsPanel());
      content.append(await experimentConfigPanel(library));
      content.append(await factorLabFrameworkPanel());
      return;
    }
    if (selected.status === 'not_connected' && selected.id !== 'factors') content.append(await contractPanel());
    const grid = element('section', null, 'grid');
    grid.setAttribute('aria-label', '全部工作区');
    for (const item of items) {
      const a = element('a', null, 'card'); a.href = `#${item.id}`;
      a.append(element('small', item.label), element('h3', item.title), element('p', item.description), element('span', item.status === 'native_module' ? '进入原生模块 →' : item.status === 'readonly_index' ? '查看只读索引 →' : item.status === 'paused_archive' ? '暂停归档 →' : '待迁入 →'));
      grid.append(a);
    }
    content.append(grid);
  }
  addEventListener('hashchange', () => { render().catch(showError); });
  render().catch(showError);
} catch (error) {
  showError(error);
}
