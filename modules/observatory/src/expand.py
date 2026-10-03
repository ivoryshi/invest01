def expand(config):
    config['version']='0.2.0'
    # Twenty groups preserve the original research lenses. Multi-window groups have subfields.
    raw=[
      ('P1','量价','趋势位置','收盘价相对MA20/60/200的偏离；价格调整口径必须一致。',[('ma20','距MA20','%'),('ma60','距MA60','%'),('ma200','距MA200','%')]),
      ('P2','量价','成交活跃度','当日成交额/此前20日平均成交额；指数不得以ETF成交替代。',[('volumeRatio','成交额相对20日','倍')]),
      ('P3','量价','换手率分位','自由流通口径，过去3年历史分位，口径缺失时不计算。',[('turnoverRank','换手率分位','%')]),
      ('P4','量价','高点回撤','当前价格/过去252日最高收盘价−1；非正数。',[('drawdown','距一年高点','%')]),
      ('P5','量价','上涨宽度','定义内成分股站上MA200的比例，必须提供样本范围与覆盖率。',[('breadth','站上MA200比例','%')]),
      ('F1','基本面','收入增长','最新可比季度或半年收入同比，严禁把累计同比直接相减。',[('revenue','收入同比','%')]),
      ('F2','基本面','利润率变化','营业利润率较上年同期变化；百分点。',[('margin','利润率同比变化','pp')]),
      ('F3','基本面','资本回报','非金融优先ROIC；银行使用ROE。两者标注分开。',[('roic','ROIC','%'),('roe','ROE','%')]),
      ('F4','基本面','盈利现金含量','TTM经营现金流/TTM净利润；亏损、银行等不按此比率判读。',[('cashQuality','经营现金流/净利润','倍')]),
      ('F5','基本面','资本开支负担','TTM现金资本开支/TTM经营现金流；分母为非正数时不按常规比率判读。',[('capexBurden','资本开支/经营现金流','%')]),
      ('V1','价值','PE TTM','亏损时不适用；当前价格与TTM盈利，保留币种和股本口径。',[('pe','PE TTM','倍')]),
      ('V2','价值','PB','结合ROE观察；净资产非正时不作便宜程度排序。',[('pb','PB','倍')]),
      ('V3','价值','自由现金流收益率','非金融企业TTM(经营现金流−现金资本开支)/总市值。',[('fcfYield','自由现金流收益率','%')]),
      ('V4','价值','现金股息率','过去12个月现金股息/当前价格；标注特别股息。',[('divYield','现金股息率','%')]),
      ('V5','价值','主要估值历史分位','过去5年，按行业固定适用指标，须披露历史长度和估值锚。',[('valuationRank','估值历史分位','%')]),
      ('M1','动量','多周期收益','1/3/6/12个月收益，默认总收益；实际口径必须在来源中标注。',[('ret1','1个月收益','%'),('ret3','3个月收益','%'),('ret6','6个月收益','%'),('ret12','12个月收益','%')]),
      ('M2','动量','相对基准收益','同区间标的总收益减基准总收益，基准及币种保持一致。',[('excess3','3个月超额收益','pp')]),
      ('M3','动量','中期动量','12—1个月收益，排除最近1个月。',[('mom12_1','12—1动量','%')]),
      ('M4','动量','风险调整动量','126日收益/同窗口日收益年化波动率，仅作描述性排序。',[('riskMomentum','风险调整动量','倍')]),
      ('M5','动量','强弱排名变化','固定样本内3个月收益百分位，较20交易日前的变化，正值表示上升。',[('rankChange','排名百分位变化','pp')])
    ]
    config['factors']=[dict(id=i,dimension=d,name=n,formula=f,fields=[dict(id=a,name=b,unit=c) for a,b,c in fields]) for i,d,n,f,fields in raw]
    additions=[
      ('cn_unemployment','城镇调查失业率','CN','%','月','nbs','官方城镇调查失业率；分年龄数据分列，不拼接不可比序列。'),
      ('cn_service','服务零售额增速','CN','%','月','nbs','官方累计同比；不能通过累计增速相减推算单月增速。'),
      ('cn_corecpi','核心CPI同比','CN','%','月','nbs','剔除食品和能源的CPI同比。'),
      ('cn_houseprice','住宅价格上涨城市数','CN','个','月','nbs','70城二手住宅价格环比上涨城市数；口径固定。'),
      ('cn_spending_income','居民消费支出/收入','CN','%','季','nbs','同一统计期居民人均消费支出/可支配收入，不等同全口径储蓄率。'),
      ('cn_shortcredit','住户短期贷款余额增速','CN','%','月','pbc','包含经营与消费相关贷款，不能全部归为消费贷。'),
      ('us_corecpi','核心CPI同比','US','%','月','bls','剔除食品和能源的CPI同比。'),
      ('us_corepceyoy','核心PCE同比','US','%','月','bea','剔除食品和能源的PCE价格指数同比。'),
      ('us_shelter','CPI住房同比','US','%','月','bls','CPI住房分项同比，与新租客租金口径不同。'),
      ('us_eci','就业成本指数同比','US','%','季','bls','固定劳动构成的工资及福利成本同比。'),
      ('us_unemployment','失业率','US','%','月','bls','官方U-3失业率；就业参与变化另行解释。'),
      ('us_claims','初请失业金四周均值','US','千人','周','dol','季调初请失业金人数四周移动均值，单位千人。'),
      ('us_expectation','居民三年通胀预期','US','%','月','nyfed','纽约联储消费者预期调查三年期通胀预期中位数。'),
      ('us_real_income','实际可支配收入同比','US','%','月','bea','真实可支配个人收入同比，与实际PCE共同观察。')]
    config['sources']['dol']=['美国劳工部','https://www.dol.gov/ui/data.pdf','初请失业保险，注意季调、修订和节假日。']
    for i,n,m,u,f,s,formula in additions:
      config['metrics'].append(dict(id=i,name=n,panel='macro',market=m,unit=u,freq=f,source=s,formula=formula,meaning='检验消费、通胀及其收入就业传导，单一读数不决定方向。'))
    config['macroModules']=[
      dict(id='CN',title='中国消费复苏',question='收入与信用改善，能否穿过价格竞争转成真实消费和企业现金？',path='收入与就业 → 消费意愿与住房 → 商品及服务消费 → 利润与回款',metrics=['cn_income','cn_unemployment','cn_consumption','cn_spending_income','cn_retail','cn_service','cn_corecpi','cn_houseprice','cn_house_credit','cn_shortcredit'],chains=['B','C']),
      dict(id='US',title='美国通胀与增长代价',question='核心通胀持续回落时，就业、需求与信用质量能否保持韧性？',path='商品、住房与工资 → 核心通胀 → 利率与融资 → 真实支出与信用损失',metrics=['us_inflation','us_corepceyoy','us_corecpi','us_shelter','us_eci','us_expectation','us_unemployment','us_claims','us_pce','us_real_income','us_delinquency'],chains=['D','E'])]
    config['backgrounds']=[dict(id=i,name=n,market=m,unit=u) for i,n,m,u in [
      ('UST10','美国10年期国债收益率','US','%'),('CGB10','中国10年期国债收益率','CN','%'),('USDCNH','美元兑离岸人民币','CN','汇率'),('VIX','VIX波动率指数','US','点'),('BRENT','布伦特原油','GLOBAL','USD/桶'),('COPPER','铜价','GLOBAL','USD/吨'),('GOLD','黄金','GLOBAL','USD/盎司'),('USDJPY','美元兑日元','JP','汇率'),('JGB10','日本10年期国债收益率','JP','%')]]
    config['narratives']=[
      dict(id='N0',name='中美信用周期与分配',type='长期专题',hypothesis='2027—2028年信用与支出的变化，能否从少数主体扩散到典型企业和居民？',support='融资需求、实际支出和现金回收形成连续改善；非头部同步受益。',counter='融资增长主要滚动偿债，投资和利润集中，尾部偿付压力持续上升。',next='部门融资、贷款供需调查及季度财报交叉确认。',chains=['A','B','C','D','E'],assets=['601668.SH','MSFT','JPM','600036.SH'],metrics=['cn_credit','us_standards','us_demand','cn_breadth','us_breadth']),
      dict(id='N1',name='AI投入与半导体回报',type='产业主线',hypothesis='算力投资能否带来终端收入与现金回报，并扩散到供应链？',support='客户变现、供应商回款和非头部盈利同步改善。',counter='资本承诺、折旧与库存快于终端需求，客户占款上升。',next='核心客户财报、资本开支指引与供应商库存回款。',chains=['D'],assets=['SOX','MSFT','AMZN','GOOGL','NVDA','AVGO','TSM','601138.SH','300308.SZ'],metrics=['us_capex','us_orders','us_top']),
      dict(id='N2',name='电力与基础设施兑现',type='产业主线',hypothesis='新增投入能否形成可执行订单、交付以及经营现金回收？',support='订单转收入，利用率与现金改善，利润率保持。',counter='订单延期、应收增加、扩产后利润率回落。',next='项目实施、设备交付、回款及在建工程披露。',chains=['A','D'],assets=['600406.SH','600900.SH','ETN'],metrics=['cn_fiscal','cn_orders','cn_receivable']),
      dict(id='N3',name='中国消费与盈利复苏',type='宏观—经营',hypothesis='收入就业改善能否带动广泛消费，而非依赖补贴和折扣？',support='商品、服务与实际收入改善，渠道库存和公司回款同步确认。',counter='交易量增长但利润率下降，改善只集中在少数品类。',next='月度消费与就业、季度收入支出、公司分部经营。',chains=['B','C'],assets=['600519.SH','000333.SZ','600887.SH','03690.HK','09988.HK','01810.HK'],metrics=['cn_income','cn_retail','cn_service','cn_consumption']),
      dict(id='N4',name='股东回报的经营支撑',type='价值与回报',hypothesis='分红与回购能否在保障必要投入后，由持续经营能力支持？',support='现金或可分配利润覆盖回报，杠杆与资本缓冲稳定。',counter='依靠新增负债、资产出售或减少必要投入维持派息。',next='分红回购公告、现金流、债务与资本充足披露。',chains=[],assets=['000922','600900.SH','00941.HK','00883.HK','01088.HK','600036.SH','JPM'],metrics=['cn_coverage','us_coverage']),
      dict(id='N5',name='资源周期与现金分配',type='产业主线',hypothesis='价格、产量和成本的组合能否形成现金回报，资本纪律是否延续？',support='单位利润和现金流改善，扩产节制且股东回报有覆盖。',counter='成本快于价格上涨，扩产吞噬现金，景气回落后分红承压。',next='产品价格、产销量、单位成本与资本开支更新。',chains=[],assets=['601899.SH','00883.HK','01088.HK','XOM'],metrics=[]),
      dict(id='N6',name='美国去通胀与资产定价',type='宏观—定价',hypothesis='通胀下行能否降低融资负担，同时保持实际需求和信用质量？',support='核心通胀近期速度趋缓，就业消费稳定、信用损失未扩散。',counter='通胀下降来自需求收缩，或住房工资压力导致反复。',next='PCE/CPI、工资就业、消费与贷款调查。',chains=['E'],assets=['SPX','NDX','RUT','JPM','COST','HD'],metrics=['us_inflation','us_eci','us_pce','us_delinquency'])]
    # Core comparison ETFs are explicitly distinct from index instruments.
    config['proxies']=[dict(id=i,name=n,market='US') for i,n in [('IWF','罗素1000成长ETF'),('IWD','罗素1000价值ETF'),('XLY','可选消费ETF'),('XLP','必需消费ETF')]]
    config['stylePairs']=[['000852','000300'],['399006','000300'],['000922','000300'],['HSTECH','HSI'],['RUT','SPX'],['SPXEW','SPX'],['IWF','IWD'],['XLY','XLP'],['SOX','NDX'],['N225','TOPIX']]
    return config
