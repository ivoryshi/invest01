export const workspaces = [
  { id: 'observatory', title: '投研观察台', label: '01 / OBSERVATORY', description: '指数、风格与量价、基本面、价值、动量信号。', next: '中美信用周期与宏观—行业—公司证据链', status: 'native_module', href: '/modules/observatory/' },
  { id: 'research', title: '投研工具', label: '02 / RESEARCH', description: '研究任务、公司分析、对比与证据核验。', next: '任务执行、工具权限、结果与来源追踪', status: 'readonly_index' },
  { id: 'factors', title: '因子实验室', label: '03 / FACTORS', description: '因子定义、数据版本、实验与结果比较。', next: '实验口径、数据快照和回测可比性' },
  { id: 'knowledge', title: '知识与证据库', label: '04 / KNOWLEDGE', description: '原始资料、知识检索、引用与版本。', next: '资料登记、检索及可追溯引用' },
  { id: 'portfolio', title: '模拟组合与复盘', label: '05 / REVIEW', description: '跟踪研究判断、模拟持仓与结果。', next: '模拟记账、判断版本和复盘记录' },
  { id: 'lance', title: 'Lance 投顾助手', label: '06 / ADVISORY', description: 'C端投顾服务与投顾助手，完整复用原产品后逐步整合。', next: '画像、内容节点、Mission与服务流程迁入' },
  { id: 'daily', title: '早晚报归档', label: 'PAUSED / DAILY', description: '每日早晚报生产与归档已暂停；保留历史快照入口，不作为当前重构主线。', next: '仅在明确恢复日报项目时再接入生产与同步', status: 'paused_archive', archiveHref: '/modules/daily/' },
].map(item => ({
  ...item,
  status: item.status || 'not_connected',
  href: item.href || null,
}));
