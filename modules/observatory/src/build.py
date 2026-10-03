import json
from expand import expand
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'public'
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).parent
panels = [
 ('credit','信用供需','钱从哪里来','融资条件改善，借款意愿是否同步增强？','供给与需求必须分别确认，收紧幅度下降不等于净放松。'),
 ('spend','支出与投入','钱用到哪里','新增融资形成支出，还是用于维持旧资产负债表？','资本开支可以来自内部现金；融资用途未披露时保留未知。'),
 ('orders','订单与产能','需求传到哪里','订单转为交付了吗？扩产是否跑在终端需求前面？','订单、收入和库存不互相替代；上下游分别观察。'),
 ('cash','利润与现金','回报留在哪里','谁获得利润与现金，谁承担应收和库存？','现金流改善要区分回款改善与延迟向供应商付款。'),
 ('debt','偿债与损失','压力何时到来','2027—2028年到期、重定价与信用损失集中在哪里？','已披露债务与情景融资假设分开；不自动推定可再融资。'),
 ('breadth','扩散与集中','多少主体改善','总体改善能否扩散至中位数企业和非头部群体？','观察池统计不代表全市场；头部组固定版本并标注覆盖率。')]
sources = {
 'pbc':('中国人民银行','https://www.pbc.gov.cn/','官方金融统计与贷款投向；需逐序列核对频率与可得口径'),
 'mof':('财政部','https://www.mof.gov.cn/','财政支出与融资分列；不得直接把发债当作新增需求'),
 'nbs':('国家统计局','https://data.stats.gov.cn/','收入消费、工业利润、库存与应收；累计和当期口径分列'),
 'fed':('美联储 Z.1','https://www.federalreserve.gov/releases/z1/default.htm','部门融资流量和存量；不可简单将存量差等同交易流量'),
 'sloos':('美联储 SLOOS','https://www.federalreserve.gov/data/sloos.htm','融资供给与贷款需求调查；季度'),
 'bea':('美国 BEA','https://www.bea.gov/data','PCE、收入与投资；保留季调及修订版本'),
 'bls':('美国 BLS','https://www.bls.gov/','CPI、工资与就业；各分项定义分别确认'),
 'census':('美国 Census M3','https://www.census.gov/manufacturing/m3/currentdata.html','制造业订单、出货、库存；行业与季调口径固定'),
 'nyfed':('纽约联储','https://www.newyorkfed.org/microeconomics/hhdc','居民债务及逾期；群体维度随原始披露'),
 'filing':('公司正式披露','https://www.sec.gov/edgar/search/','SEC、交易所及公司IR原始文件；公司链接在导入时逐条提供'),
 'calc':('固定观察池计算',None,'由已核实公司数据计算；保留样本、规则与头部组版本'),
 'quote':('授权行情供应商',None,'尚未连接账户；指数代码、总收益与价格收益映射待核验')
}
metrics=[]
def m(id,name,panel,market,unit,freq,source,formula,meaning):
 metrics.append(dict(id=id,name=name,panel=panel,market=market,unit=unit,freq=freq,source=source,formula=formula,meaning=meaning))
m('cn_credit','非政府债券社融增速','credit','CN','%','月','pbc','社融存量扣除政府债券后，按同口径计算同比；不等于民营信用。','政府融资之外的信用是否改善？')
m('cn_house_credit','住户贷款余额增速','credit','CN','%','月','pbc','住户贷款余额同比；经营贷、消费贷与住房贷款另行下钻。','居民是否扩张资产负债表？')
m('us_standards','工商贷款净收紧比例','credit','US','%','季','sloos','SLOOS大型及中型企业工商贷款标准净收紧比例。正值表示净收紧。','信贷供给是否仍在收紧？')
m('us_demand','工商贷款净需求增强比例','credit','US','%','季','sloos','同组企业贷款需求净增强比例；与供给调查分开展示。','融资需求是否自主恢复？')
m('cn_fiscal','一般公共预算支出增速','spend','CN','%','月','mof','官方累计支出同比；与政府性基金预算分列，不相加制造单一财政脉冲。','融资是否转成支出？')
m('cn_consumption','居民实际消费支出增速','spend','CN','%','季','nbs','居民人均消费支出实际累计同比；同季可比。','收入和信用是否传向最终需求？')
m('cn_income','居民实际收入增速','spend','CN','%','季','nbs','居民人均可支配收入实际累计同比。','消费能力是否具有收入支撑？')
m('cn_retail','社零当期同比','spend','CN','%','月','nbs','社会消费品零售总额名义同比；1—2月合并观察，不等于全部消费。','商品消费是否形成当期确认？')
m('us_capex','核心资本品出货增速','spend','US','%','月','census','非国防资本品剔除飞机出货额同比；名义值。','一般企业投资是否跟随龙头扩张？')
m('us_pce','实际PCE同比','spend','US','%','月','bea','实际个人消费支出同比，采用一致版本。','去通胀是否仍伴随需求韧性？')
m('us_inflation','核心PCE三个月年化','spend','US','%','月','bea','以季调价格指数计算：(本月指数/三个月前指数)^4−1，再乘100。','近期通胀速度是否下降？不预先认定方向。')
m('cn_inventory','产成品库存周转天数','orders','CN','天','月','nbs','规模以上工业企业官方周转天数，保留统计范围。','生产是否快于需求？')
m('cn_orders','制造业PMI新订单','orders','CN','点','月','nbs','官方制造业PMI新订单分项；扩散指数，不是订单金额。','订单改善是否开始扩散？')
m('us_orders','核心资本品订单增速','orders','US','%','月','census','非国防资本品剔除飞机新订单额同比；名义值。','设备投资需求是否具有延续性？')
m('us_inventory','制造业库存销售比','orders','US','倍','月','census','相同范围的季调制造业库存/当月出货额。','库存相对出货是否堆积？')
m('cn_receivable','工业应收回收期','cash','CN','天','月','nbs','规模以上工业企业应收账款平均回收期。','企业是否在为客户垫资？')
m('cn_margin','工业营业收入利润率','cash','CN','%','月','nbs','官方利润总额/营业收入，累计口径；非上市公司营业利润率。','中观利润是否兑现？')
m('cn_ocf','观察池现金流率中位数','cash','CN','%','季','calc','固定CN非金融样本企业TTM经营现金流/收入的中位数。','典型企业有没有拿到现金？')
m('us_ocf','观察池现金流率中位数','cash','US','%','季','calc','固定US非金融样本企业TTM经营现金流/收入的中位数。','利润与现金是否一致？')
m('cn_coverage','观察池利息覆盖中位数','debt','CN','倍','季','calc','非金融企业TTM EBIT/利息费用；零分母及缺失排除并披露。','典型企业的偿债缓冲如何？')
m('us_coverage','观察池利息覆盖中位数','debt','US','倍','季','calc','非金融企业TTM EBIT/利息费用，保留负值与有效样本。','融资成本是否蚕食回报？')
m('us_delinquency','信用卡严重逾期迁入率','debt','US','%','季','nyfed','纽约联储披露的信用卡余额迁入90天以上逾期的年化口径。','居民信用压力是否累积？')
m('cn_breadth','现金流率改善企业占比','breadth','CN','%','季','calc','固定CN非金融池中TTM现金流率同比改善企业/有效可比企业。','改善是否扩散至更多企业？')
m('us_breadth','现金流率改善企业占比','breadth','US','%','季','calc','固定US非金融池中TTM现金流率同比改善企业/有效可比企业。','整体改善是否具有宽度？')
m('cn_top','头部组资本开支占比','breadth','CN','%','季','calc','固定样本与固定头部组，头部现金资本开支/全样本现金资本开支。','投资是否进一步集中？')
m('us_top','头部组资本开支占比','breadth','US','%','季','calc','固定样本与固定头部组，头部现金资本开支/全样本现金资本开支。','大型企业与一般企业是否分化？')
chains=[
 dict(id='A',name='财政与项目支出',market='CN',question='政府融资能否形成项目支出，并传至承包商现金回收？',funding='政府融资 · 财政支出 · 项目资金落实',nodes=[['上游材料','金属、水泥价格与销量；库存'],['中游设备与施工','新订单、交付、应收与合同资产'],['下游项目运营','项目执行、运营收入与承包商回款']],support='支出执行、交付与现金回收连续改善，且非头部企业同步受益。',counter='发债增加，但项目支出滞后、应收持续上升。',metrics=['cn_credit','cn_fiscal','cn_orders','cn_receivable','cn_breadth']),
 dict(id='B',name='住房与耐用品',market='CN',question='居民资产负债表修复，能否转化为住房与耐用品自主需求？',funding='居民收入 · 按揭与消费融资 · 住房交付',nodes=[['上游建材','价格、开工与库存'],['中游开发与制造','交付、库存、资本占用'],['下游居民与渠道','销售、回款、折扣及偿债']],support='住房交付和终端销售改善，库存回落且回款增强。',counter='补贴品类增长，但居民融资、收入和其他消费未改善。',metrics=['cn_house_credit','cn_income','cn_consumption','cn_retail','cn_inventory']),
 dict(id='C',name='消费与渠道',market='CN',question='收入改善能否穿过价格竞争，最终形成利润和现金？',funding='就业工资 · 实际收入 · 消费倾向',nodes=[['上游投入','食品原料、包装价格'],['中游品牌','销量、售价、促销与毛利率'],['下游渠道与服务','动销、库存、账期与经营利润']],support='收入与消费广泛改善，品牌及渠道现金流共同增强。',counter='销量依赖折扣，渠道库存、账期与促销负担加重。',metrics=['cn_income','cn_consumption','cn_retail','cn_margin','cn_ocf']),
 dict(id='D',name='AI与电力资本开支',market='GLOBAL',question='集中投入能否形成终端回报，并扩散到非头部供应商？',funding='客户内部现金 · 债务 · 租赁与项目融资',nodes=[['上游芯片与设备','订单、产能与资本投入'],['中游算力与电力','交付、库存、客户占款'],['下游云与应用','利用率、变现、折旧与回报']],support='客户经营回报、供应商回款与非头部增长共同改善。',counter='投入及采购承诺扩张，终端变现落后、折旧负担上升。',metrics=['us_capex','us_orders','us_ocf','us_top','cn_top']),
 dict(id='E',name='美国一般企业与居民',market='US',question='通胀和融资成本下降，是否能越过再融资压力传向实体？',funding='银行信贷 · 债券再融资 · 按揭及消费融资',nodes=[['上游工业需求','原材料与核心资本品订单'],['中游制造与建造','交付、成本、库存及利息费用'],['下游消费与银行','销量、折扣、逾期及信用损失']],support='核心通胀趋缓，贷款需求和真实支出改善，逾期未扩大。',counter='通胀下降伴随需求收缩，信用利差及逾期压力上升。',metrics=['us_inflation','us_standards','us_demand','us_pce','us_delinquency'])]
raw=[
 ('工业富联','601138.SH','CN','D','中游','制造'),('中际旭创','300308.SZ','CN','D','中游','制造'),('国电南瑞','600406.SH','CN','A','中游','设备'),('长江电力','600900.SH','CN','A','下游','运营'),('贵州茅台','600519.SH','CN','C','中游','消费'),('美的集团','000333.SZ','CN','B','中游','制造'),('紫金矿业','601899.SH','CN','A','上游','资源'),('招商银行','600036.SH','CN','B','金融','银行'),
 ('腾讯控股','00700.HK','HK','C','下游','平台'),('阿里巴巴','09988.HK','HK','C','下游','平台'),('美团','03690.HK','HK','C','下游','平台'),('小米集团','01810.HK','HK','B','中游','制造'),('中国移动','00941.HK','HK','D','下游','运营'),('中国海洋石油','00883.HK','HK','A','上游','资源'),('中国神华','01088.HK','HK','A','上游','资源'),('香港交易所','00388.HK','HK','E','金融','交易所'),
 ('微软','MSFT','US','D','下游','平台'),('亚马逊','AMZN','US','D','下游','平台'),('英伟达','NVDA','US','D','中游','芯片'),('博通','AVGO','US','D','中游','芯片'),('伊顿','ETN','US','D','中游','设备'),('摩根大通','JPM','US','E','金融','银行'),('好市多','COST','US','E','下游','消费'),('埃克森美孚','XOM','US','E','上游','资源'),
 ('海螺水泥','600585.SH','CN','A','上游','材料'),('三一重工','600031.SH','CN','A','中游','设备'),('中国建筑','601668.SH','CN','A','中游','施工'),('保利发展','600048.SH','CN','B','中游','地产'),('索菲亚','002572.SZ','CN','B','中游','制造'),('伊利股份','600887.SH','CN','C','中游','消费'),('安井食品','603345.SH','CN','C','中游','消费'),('Alphabet','GOOGL','US','D','下游','平台'),('台积电ADR','TSM','US','D','上游','芯片'),('卡特彼勒','CAT','US','E','中游','设备'),('D.R. Horton','DHI','US','E','中游','地产'),('通用汽车','GM','US','E','中游','制造'),('家得宝','HD','US','E','下游','消费'),('Capital One','COF','US','E','金融','银行')]
companies=[dict(id=r[1],name=r[0],market=r[2],chain=r[3],stage=r[4],sector=r[5],anchor=i<24) for i,r in enumerate(raw)]
indices=[('沪深300','CN','000300'),('中证500','CN','000905'),('中证1000','CN','000852'),('创业板指','CN','399006'),('科创50','CN','000688'),('中证红利','CN','000922'),('恒生指数','HK','HSI'),('恒生中国企业指数','HK','HSCEI'),('恒生科技指数','HK','HSTECH'),('标普500','US','SPX'),('纳斯达克100','US','NDX'),('罗素2000','US','RUT'),('标普500等权重','US','SPXEW'),('费城半导体指数','US','SOX'),('TOPIX','JP','TOPIX'),('日经225','JP','N225')]
styles=[('A股大小盘','中证1000 / 沪深300','CN'),('A股成长代理','创业板指 / 沪深300','CN'),('A股红利','中证红利 / 沪深300','CN'),('港股科技代理','恒生科技 / 恒生指数','HK'),('美股大小盘','罗素2000 / 标普500','US'),('美股上涨集中度','标普500等权重 / 标普500','US'),('美股成长与价值','IWF / IWD','US'),('美股消费结构','XLY / XLP','US'),('半导体相对强弱','SOX / 纳斯达克100','US'),('日本指数结构','日经225 / TOPIX','JP')]
config=dict(version='0.1.0',panels=[dict(zip(['id','name','short','question','caution'],p)) for p in panels],sources=sources,metrics=metrics,chains=chains,companies=companies,indices=[dict(name=n,market=mk,id=i) for n,mk,i in indices],styles=[dict(name=n,pair=p,market=mk) for n,p,mk in styles])
config=expand(config)
(OUT/'research-config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2))
template={'schemaVersion':1,'datasetLabel':'填写数据集名称','records':[{'metricId':'us_inflation','period':'2026-07-31','publishedAt':'2026-08-28','value':None,'sourceUrl':'https://www.bea.gov/data/personal-consumption-expenditures-price-index','sourceLabel':'BEA 原始发布','sampleSize':None,'notes':'将 value 替换为核验后的数值。示例日期只演示格式，请以原始发布为准。'}]}
(OUT/'data-template.json').write_text(json.dumps(template,ensure_ascii=False,indent=2))
html=(ROOT/'shell.html').read_text().replace('/* CONFIG_SLOT */','const CFG = '+json.dumps(config,ensure_ascii=False)+';').replace('/* APP_SLOT */',(ROOT/'app.js').read_text()+'\n'+(ROOT/'complete.js').read_text()+'\n'+(ROOT/'integration.js').read_text()+'\nrender();')
# Separate executable code from HTML so the module can use a strict script policy.
import re
style=re.search(r'<style>([\s\S]*?)</style>',html).group(1)
script=re.search(r'<script>([\s\S]*?)</script>',html).group(1)
html=re.sub(r'<style>[\s\S]*?</style>','<link rel="stylesheet" href="./styles.css">',html)
html=re.sub(r'<script>[\s\S]*?</script>','<script src="./app.js" defer></script>',html)
(OUT/'styles.css').write_text(style)
(OUT/'app.js').write_text(script)
(OUT/'index.html').write_text(html)
print(f'Built: {len(metrics)} metrics, {len(companies)} companies, {len(indices)} indices, {len(chains)} chains')
