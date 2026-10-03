# 开发与验收

运行基线：Node.js 22.23.1，ES Modules；根 package.json 声明支持的 22.x 范围，.nvmrc 固定本次验证版本。零第三方依赖，无需安装，因此暂无依赖锁文件；引入依赖时必须一并生成锁文件。

npm start 启动本地页面和 API；npm run check 检查 JavaScript 语法与 Markdown 相对链接；npm test 检查 HTTP 行为、六区配置、静态文件边界和写方法限制。

API：GET /api/health 返回进程健康和 dataConnected=false，不代表上游数据源健康；GET /api/workspaces 返回六区定义，全部 not_connected。入口配置位于 packages/contracts/workspaces.js。

测试按实际风险设计；独立子 Agent 只读审查，主 Agent 在批准范围内修复。浏览器视觉与交互验收和命令行测试分别记录，不相互替代。

后续技术选型、业务数据和持久化尚待对应批次确认。

A01：当前本机Node 24.14.0，.nvmrc固定该版本；22.23.1保留为N01历史基线。新增build、test:observatory及独立启动命令，见[A01说明](A01-观察台与日报接入.md)。
