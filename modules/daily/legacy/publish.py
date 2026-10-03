"""Validate, render and publish an editorial report; no retrieval or State mutation."""
import json,sys,html,hashlib,subprocess,os
from pathlib import Path
from datetime import datetime
ROOT=Path(__file__).resolve().parents[2]
def validate(d):
 for k in ['report_id','edition','report_date','cutoff_at','title','summary','timezone']:
  assert isinstance(d.get(k),str) and d[k],k
 assert d['timezone']=='Asia/Shanghai'
 cutoff=datetime.fromisoformat(d['cutoff_at'].replace('Z','+00:00'));assert cutoff.tzinfo
 assert d['qa']['synthetic'] is False and d['qa']['status'] in ['READY','DEGRADED']
 assert d['publication']['kind'] in ['scheduled','late_supplement','manual_weekend']
 assert d['state_update']['status']=='NOT_COMMITTED'
 assert 0<=len(d['objects'])<=24 and len(d['top_ids'])<=5
 ids=[x['id'] for x in d['objects']];sids=[x['id'] for x in d['sources']]
 assert len(set(ids))==len(ids) and len(set(sids))==len(sids)
 assert set(d['top_ids'])<=set(ids)
 for s in d['sources']:
  assert not s.get('url') or s['url'].startswith(('https://','http://'))
  assert datetime.fromisoformat(s['retrieved_at'].replace('Z','+00:00'))<=cutoff
 for o in d['objects']:
  assert o['verification'] in ['VERIFIED','MULTI_SOURCE_VERIFIED']
  assert o['sources'] and set(o['sources'])<=set(sids)
  for k in ['fact','signal','inference','decision','invalidation']:assert isinstance(o[k],str) and o[k]
 for r in d.get('market_rows',[]):
  assert datetime.fromisoformat(r['observed_at'].replace('Z','+00:00'))<=cutoff
 return d
from report_template import render
def publish(d):
 validate(d);name=d['report_id'];assert '/' not in name and '\\' not in name
 out=ROOT/'outputs/investment-daily'/d['report_date'];out.mkdir(parents=True,exist_ok=True)
 raw=json.dumps(d,ensure_ascii=False,indent=2);target=out/(name+'.json')
 if target.exists():assert target.read_text()==raw,'Published version differs; use new revision'
 # HTML first; JSON is the publication marker. A repeated identical run repairs rendering.
 h=out/(name+'.html');tmp=h.with_suffix('.html.tmp');tmp.write_text(render(d));os.replace(tmp,h)
 tmp=target.with_suffix('.json.tmp');tmp.write_text(raw);os.replace(tmp,target)
 subprocess.run([sys.executable,str(ROOT/'work/dashboard/build.py')],check=True,cwd=ROOT)
 c=json.loads((ROOT/'outputs/credit-cycle-dashboard/daily/catalog.json').read_text());digest=hashlib.sha256(target.read_bytes()).hexdigest()
 assert any(r['sha256']==digest and r['htmlPath'] for r in c['reports'])
 print('PUBLISHED',h)
if __name__=='__main__': raise SystemExit('Reference only: scheduled production is not enabled in this copied module.')
