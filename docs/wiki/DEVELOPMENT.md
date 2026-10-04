# 开发与验收

当前v0.5.1，Node基线24.14.0（.nvmrc），ES Modules、原生HTTP与浏览器模块，零npm第三方依赖，无需npm install。package.json还声明支持22.23.1以上22.x，但本批没有重做双版本矩阵。Python执行依赖与版本见[requirements](../../modules/factors/requirements.txt)。

## 目录与责任

| 目录 | 责任 |
|---|---|
| apps/web | 原生工作台、表单、图表、模块挂载和交互状态 |
| apps/api | 本地HTTP路由、严格公开资产、配置/结果存储和执行交接 |
| packages/contracts | 工作区、实体与因子定义/策略/数据候选契约 |
| modules/factors/src | Python计算、离线数据库/归档/冻结与源码捕获 |
| modules/observatory | 已迁入观察台及构建/专项校验 |
| modules/daily | 暂停生产的历史模块，非默认构建/测试范围 |
| scripts | 检查、构建入口、离线维护与模块启动 |
| tests | 隔离计算、API集成、内存表单/状态、存储与失败场景 |
| var | 本机运行数据，不入Git，不是公开文件根 |

## 验证分层

- npm run check：JavaScript语法和Markdown本地链接；不证明Python计算或浏览器显示。
- npm run test:portable：不需私有数据/NumPy的隔离维护及捕获源码测试，仍需Python 3与Node。
- npm test：全部Node测试入口，部分调用Python/授权真实数据及SQLite API；不是无数据环境的验收承诺。
- npm run build：仅重建观察台，不抓取、不回测、不恢复日报。
- npm run test:observatory：观察台专项结构/逻辑校验；当前历史基线182项。
- git diff --check：差异空白，不证明逻辑正确。
- 真实浏览器：独立记录页面加载、表单提交/切换、图表比较、版本/错误反馈与移动端。内存DOM测试不代替此层。

集成测试会暂存/恢复本机配置、请求、结果，运行期间不要同时操作真实研究或并发跑另一轮完整测试；新测试尽量用临时目录/fixture。运行后核验没有留下测试资产。未验证的层必须明确登记。

## 环境与启动

先确保PATH中的python3为正确环境；Node执行器不自动使用.venv路径，也不安装包。npm start默认4311，PORT只接受1至65535，固定127.0.0.1。Ctrl+C停止，后端修改需重启。/api/health只表示进程健康，当前dataConnected=false不等于所有本地源不可用。

Python主文件及执行时import的本地模块要同时纳入executePinnedPython捕获；直接读取编辑中的文件后仅记录另一次SHA不能保证执行身份。新增回测需验证源变化、配置revision、费用与时间边界、失败不产生伪结果、current/frozen一致性（支持冻结的引擎）。

## 工作流

按[贡献规范](../../CONTRIBUTING.md)执行需求/范围 → 实施 → 自动测试 → 独立只读审查/修复 → 文档/状态 → Git远端SHA核验。新增依赖需确认并维护锁文件/许可；当前没有Node锁文件是因为没有第三方依赖，不表示可任意升级环境。来源、数据、未知风险和批准保持可追溯。

N01的Node22/只读HTTP六区骨架是历史阶段；后来已扩展七入口、因子写入/SQLite与真实执行，不沿用旧“全部not_connected、无持久化”的结论。整体架构V2、认证和生产上线仍另行处理。
