"""Recover strict JSON literals from archived scripts without evaluating JavaScript."""
import hashlib
import json
import re
import sys
from html.parser import HTMLParser


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts = []; self.current = None; self.controls = []; self.select = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script': self.current = []
        if self.current is not None: return
        attrs = dict(attrs)
        if tag in ['input','select'] and (attrs.get('id') or attrs.get('name') or attrs.get('data-k')):
            if len(self.controls)>=256: raise ValueError('legacy_html_control_limit')
            item = {k:attrs[k] for k in ['id','name','data-k','type','value','min','max','step'] if k in attrs}
            item['tag'] = tag
            if tag == 'input' and attrs.get('type') in ['checkbox','radio']: item['checked'] = 'checked' in attrs
            self.controls.append(item)
            if tag == 'select': self.select = item; item['options'] = []
        elif tag == 'option' and self.select is not None:
            if len(self.select['options'])>=128: raise ValueError('legacy_html_option_limit')
            self.select['options'].append({'value':attrs.get('value'),'selected':'selected' in attrs})

    def handle_endtag(self, tag):
        if tag == 'script' and self.current is not None:
            self.scripts.append(''.join(self.current)); self.current = None
        if tag == 'select': self.select = None

    def handle_data(self, data):
        if self.current is not None: self.current.append(data)


def bounded(value, depth=0):
    if depth > 5: return {'omitted': 'depth_limit'}
    if isinstance(value, dict):
        if len(value)>64: return {'omitted': 'field_limit', 'fields': len(value)}
        return {k: bounded(v,depth+1) for k,v in value.items()}
    if isinstance(value, list):
        return [bounded(v,depth+1) for v in value] if len(value)<=32 else {'omitted':'array_limit','observations':len(value)}
    if isinstance(value, str): return value[:2000]
    return value


def code_mask(script):
    """Conservative lexical mask: ambiguous slash expressions skip the whole line."""
    chars = list(script); i = 0
    while i < len(script):
        start = i; char = script[i]
        if char in ['"', "'", '`']:
            quote = char; i += 1
            while i < len(script):
                if script[i] == '\\': i += 2
                elif quote == '`' and script.startswith('${',i):
                    # Nested template interpolation needs a full JS parser. Omit
                    # the remaining script instead of guessing its boundaries.
                    i = len(script); break
                elif script[i] == quote: i += 1; break
                else: i += 1
        elif script.startswith('/*', i):
            end = script.find('*/', i+2); i = len(script) if end<0 else end+2
        elif char == '/':
            # This deliberately omits some valid assignments after division/regex.
            end = script.find('\n',i); i = len(script) if end<0 else end
        else: i += 1; continue
        for j in range(start,min(i,len(script))):
            if chars[j] not in ['\r','\n']: chars[j] = ' '
    return ''.join(chars)


def recover(raw):
    parser = Scripts(); parser.feed(raw.decode('utf-8'))
    decoder = json.JSONDecoder(parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))
    pattern = re.compile(r'(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|\b(window\.__[A-Za-z0-9_]+__))\s*=\s*(?=[\[{])')
    items = []
    for index, script in enumerate(parser.scripts):
        for match in pattern.finditer(code_mask(script)):
            if len(items)>=100: raise ValueError('legacy_html_literal_limit')
            name = match.group(1) or match.group(2)
            if not name.startswith('window.__') and name not in ['BASE','PE','MONTHS','CFG','PLAN','FL_CFG','UNSAFE','PREFIX']:
                continue
            item = {'literalName': name, 'scriptIndex': index, 'characterOffset': match.end(),
                    'parserPolicy':'strict_json_conservative_lexical_mask_v2_not_runtime_configuration'}
            try:
                value, end = decoder.raw_decode(script,match.end())
                rest = script[end:].lstrip()
                if rest and not rest.startswith(';'): raise ValueError('not_standalone_literal')
                literal = script[match.end():end]
                if len(literal)>32*1024*1024: raise ValueError('literal_size_limit')
                params = {key:bounded(v) for key,v in value.items() if key.lower() in ['cfg','config','params','parameters','weights','defaults','settings']} if isinstance(value,dict) else {}
                if not params and isinstance(value,dict) and len(value)<=32 and all(not isinstance(v,(dict,list)) for v in value.values()): params = bounded(value)
                item.update({'status':'strict_json_recovered_not_executed','literalSha256':hashlib.sha256(literal.encode()).hexdigest(),
                             'keys': list(value)[:64] if isinstance(value,dict) else [], 'parameters':params or None,
                             'arrays': {key:{'observations':len(v)} for key,v in value.items() if isinstance(v,list)} if isinstance(value,dict) else {'root':{'observations':len(value)}}})
            except (ValueError, RecursionError):
                item.update({'status':'unsupported_javascript_literal_not_evaluated','parameters':None,'keys':[],'arrays':{}})
            items.append(item)
    for control in parser.controls:
        options = control.get('options',[])
        if options:
            selected = [v for v in options if v['selected']]
            control['staticValue'] = (selected[-1] if selected else options[0])['value']
    if parser.controls:
        items.append({'literalName':'static_form_defaults','scriptIndex':-1,'characterOffset':0,
                      'status':'static_html_defaults_not_runtime_state','parameters':{'controls':parser.controls},
                      'keys':[],'arrays':{},'policy':'HTML attributes only; JavaScript changes, generated controls, units and user state not inferred'})
    return {'sourceSha256':hashlib.sha256(raw).hexdigest(),'items':items}


if __name__ == '__main__':
    raw = sys.stdin.buffer.read(64*1024*1024+1)
    if len(raw)>64*1024*1024: raise ValueError('legacy_html_size_limit')
    print(json.dumps(recover(raw),ensure_ascii=False,allow_nan=False))
