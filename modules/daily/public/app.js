const state = { date: '', mode: 'ALL', q: '', selected: null };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = kind => ({ scheduled: '正式版', late_supplement: '补刊', manual_weekend: '周末手动版', early: '提前版' })[kind] || '版次待核实';
let catalog = { reports: [] };

async function load() {
  const response = await fetch('./catalog.json');
  if (!response.ok) throw new Error('日报目录不可用');
  catalog = await response.json();
  render();
}
function filtered() {
  const q = state.q.toLowerCase();
  return catalog.reports.filter(report => (!state.date || report.date === state.date) && (state.mode === 'ALL' || report.mode === state.mode) && (!q || JSON.stringify(report).toLowerCase().includes(q)));
}
function render() {
  const reports = filtered();
  const selected = reports.find(report => report.archiveKey === state.selected) || reports[0];
  state.selected = selected?.archiveKey || null;
  $('#summary').innerHTML = `<div class="stats"><div class="stat"><small>归档报告</small><b>${catalog.reports.length}</b></div><div class="stat"><small>当前筛选</small><b>${reports.length}</b></div><div class="stat"><small>正式版</small><b>${catalog.reports.filter(r=>r.publicationKind==='scheduled').length}</b></div><div class="stat"><small>质量缺口</small><b>${catalog.reports.filter(r=>r.qualityStatus!=='PASS').length}</b></div></div>`;
  $('#list').innerHTML = reports.map(report => `<button class="report-card ${report.archiveKey===state.selected?'active':''}" data-key="${esc(report.archiveKey)}"><span class="eyebrow">${esc(report.date)} · ${esc(report.mode)} · ${esc(label(report.publicationKind))}</span><h3>${esc(report.title)}</h3><p>${esc(report.summary)}</p><span class="badge">${esc(report.qualityStatus)}</span></button>`).join('') || '<div class="report-card">没有匹配报告。</div>';
  $('#detail').innerHTML = selected ? detail(selected) : '<h2>请选择报告</h2>';
}
function detail(report) {
  return `<span class="eyebrow">${esc(report.edition)} · 截至 ${esc(report.cutoffAt)}</span><h2>${esc(report.title)}</h2><p>${esc(report.summary)}</p><div class="links">${report.htmlUrl?`<a href="${esc(report.htmlUrl)}" target="_blank" rel="noopener">打开原版 HTML</a>`:''}${report.jsonUrl?`<a href="${esc(report.jsonUrl)}" target="_blank" rel="noopener">打开原始 JSON</a>`:''}</div><p>缺口：${esc(report.missing.join('；') || '无登记缺口')}</p><p class="hash">内容哈希：${esc(report.sha256)}</p><h3>信号对象</h3>${report.objects.map(object => `<section class="object"><span class="eyebrow">${esc(object.id)} · ${esc(object.verification || '待核验')} · ${esc(object.asset || '')}</span><h3>${esc(object.title)}</h3><p><b>事实</b><br>${esc(object.fact || '')}</p><p><b>决策含义</b><br>${esc(object.decision || '')}</p><p>来源：${esc((object.sources || []).join(' / '))}</p></section>`).join('')}<h3>来源</h3>${report.sources.map(source => `<p>${esc(source.id)} · ${source.url ? `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title)}</a>` : esc(source.title)}<br>${esc(source.tier || '')}</p>`).join('')}`;
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-key]');
  if (!button) return;
  state.selected = button.dataset.key;
  render();
});
$('#filters').addEventListener('submit', event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  Object.assign(state, { date: data.date, mode: data.mode, q: data.q, selected: null });
  render();
});
$('#clear').addEventListener('click', () => {
  Object.assign(state, { date: '', mode: 'ALL', q: '', selected: null });
  $('#filters').reset();
  render();
});
load().catch(error => { document.body.innerHTML = `<main><h1>日报加载失败</h1><p>${esc(error.message)}</p></main>`; });
