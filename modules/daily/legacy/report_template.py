"""September 11 editorial design. Presentation only; no retrieval or new analysis."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import html,json
E=lambda x:html.escape(str(x if x is not None else '未提供'))
def section(id,title,caption=''):
 return f'<section class="section" id="{id}"><div class="sectionhead"><h2>{E(title)}</h2><span>{E(caption)}</span></div>'
def render(d):
 css=Path(__file__).with_name('report.css').read_text()
 cutoff=datetime.fromisoformat(d['cutoff_at'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')
 label='投资决策早报' if '-AM-' in d['report_id'] else '投资决策晚报'
 body=f'<header class="masthead"><div class="wrap"><div class="mastline"><div class="brand">DAILY INVESTMENT DECISION INTELLIGENCE<b>{label}</b></div><div class="issue"><strong>{E(d["report_date"])}</strong><span>机构研究版</span></div></div><p class="kicker">GLOBAL MACRO · CROSS-ASSET · DECISION REVIEW</p><h1>{E(d["title"])}</h1><p class="deck">{E(d["summary"])}</p><div class="edition"><span class="warning">{E(d["edition"])}</span><span>截止：{cutoff} 北京时间</span><span>{E(d["qa"]["status"])}</span></div></div></header>'
 body+='<nav class="toolbar" aria-label="报告目录"><div class="wrap navrow"><div class="navlinks"><a href="#summary">核心观察</a><a href="#markets">市场快照</a><a href="#objects">决策对象</a><a href="#review">验证与边界</a><a href="#sources">来源</a></div><div class="actions"><button onclick="window.print()">打印 / 保存PDF</button><button onclick="downloadHTML()">下载本页</button></div></div></nav><main><div class="wrap">'
 body+='<section class="briefbox" id="summary"><div class="label">EXECUTIVE DECISION VIEW</div><h2>本期核心观察</h2><p>'+E(d['summary'])+'</p><div class="chain">'
 by={o['id']:o for o in d['objects']}
 for id in d['top_ids'][:3]:
  o=by[id];body+='<div><strong>'+E(o['title'])+'</strong><p>'+E(o['signal'])+'</p></div>'
 body+='</div></section>'+section('markets','市场快照','SOURCE SNAPSHOT · SESSION MATTERS')
 body+='<p class="note">以下按原始响应字段展示。常规行情字段与夜盘分别列示，供应商时间刷新不等于产生新成交；盘前和不同交易时段不可直接混比。</p><div class="tablewrap"><table class="markettable"><thead><tr><th>对象</th><th>常规字段 last_done</th><th>常规字段时间 UTC</th><th>夜盘价格</th><th>夜盘时间 UTC</th></tr></thead><tbody>'
 for q in d.get('quotes',[]):
  ov=q.get('overnight') or {};body+=f'<tr><td>{E(q["symbol"])}</td><td class="num">{E(q.get("last_done"))}</td><td>{E(q.get("timestamp"))}</td><td class="num">{E(ov.get("last_done"))}</td><td>{E(ov.get("timestamp"))}</td></tr>'
 if not d.get('quotes'):body+='<tr><td colspan="5">本期没有原始行情快照。</td></tr>'
 body+='</tbody></table></div></section>'+section('objects','决策对象与研究观察','FACT / SIGNAL / INFERENCE / DECISION')+'<div class="toplist">'
 for i,id in enumerate(d['top_ids'],1):body+=f'<a class="toplink" href="#object-{E(id)}"><em>{i:02}</em><div><strong>{E(by[id]["title"])}</strong><small>{E(by[id].get("asset",""))}</small></div></a>'
 body+='</div>'
 for i,o in enumerate(d['objects'],1):
  refs=' '.join(f'<a class="ref" href="#source-{E(s)}">[{E(s)}]</a>' for s in o['sources'])
  body+=f'<article class="object" id="object-{E(o["id"])}"><div class="obj-head"><div class="obj-id">{i:02}<small>{E(o["id"])}</small></div><div><div class="asset">{E(o.get("asset",""))}</div><h3>{E(o["title"])}</h3><div class="obj-meta"><span class="badge">{E(o["verification"])}</span><span>{refs}</span></div></div></div><div class="layers">'
  for k,label in [('fact','FACT / 事实'),('signal','SIGNAL / 信号'),('inference','INFERENCE / 推断'),('decision','DECISION / 观察行动')]:body+=f'<div class="layer {"decision" if k=="decision" else ""}"><div class="layer-label">{label}</div><p>{E(o[k])}</p></div>'
  body+='</div><div class="obj-bottom"><p><strong>失效与证伪条件</strong>　'+E(o['invalidation'])+'</p></div></article>'
 body+='</section>'+section('review','验证边界与状态记录','WHAT REMAINS UNKNOWN')+'<div class="warningbox"><p>'+E(d['state_update']['reason'])+'</p><p>'+E('；'.join(d['qa']['missing']))+'</p><p>'+E(d['qa'].get('method',''))+'</p></div></section>'
 body+=section('sources','来源与证据索引','S0-FIRST · NOT S0-DOGMATIC')+'<div class="source-list">'
 for s in d['sources']:
  body+=f'<div class="source" id="source-{E(s["id"])}"><span class="sourceid">{E(s["id"])} · {E(s.get("tier",""))}</span><br><strong>{E(s["title"])}</strong><p>采集：{E(s.get("retrieved_at"))}</p>'
  if s.get('url'):body+=f'<a href="{E(s["url"])}" target="_blank" rel="noopener noreferrer">查看原始页面 ↗</a><span class="print-url">{E(s["url"])}</span>'
  else:body+='<a href="#technical">查看报告及内嵌证据 ↓</a>'
  body+='</div>'
 body+='</div></section><details class="technical" id="technical"><summary>报告版本、数据来源与机器可读副本</summary><p>报告ID：'+E(d['report_id'])+'</p><p>版式：2026-09-11机构研究模板；内容依据原报告JSON，排版不改变事实与判断。</p><button onclick="downloadData()">下载报告及行情证据 JSON</button></details><footer class="footer"><p>Daily Investment Decision Intelligence<br>The goal is not to know more, but to reduce decision error.</p><p>请结合来源、截止时间与失效条件阅读。</p></footer></div></main>'
 payload=json.dumps(d,ensure_ascii=False).replace('<','\\u003c')
 js="""function save(name,text,type){const u=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}function downloadData(){const t=document.getElementById('report-data').textContent;save(JSON.parse(t).report_id+'.json',t,'application/json')}function downloadHTML(){save(JSON.parse(document.getElementById('report-data').textContent).report_id+'.html','<!doctype html>'+document.documentElement.outerHTML,'text/html')}"""
 return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+E(d['title'])+'</title><style>'+css+'</style></head><body>'+body+'<script id="report-data" type="application/json">'+payload+'</script><script>'+js+'</script></body></html>'
