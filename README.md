# 投研工作台01

本地优先的投研工作台，原生整合观察台、研究索引与因子实验室。当前本地版本 **v0.5.4 / 因子迁移 V0.21**。源码发布使用 [release/factor-migration-v1](https://github.com/ivoryshi/invest01/tree/release/factor-migration-v1)，本版远端状态以发布回执为准，不是已经部署的在线服务。

**因子实验室可执行，但完整迁移尚未关闭。** 回测工具和项目内Skill首版已接通只读预检、明确确认执行、结果复用与结构审计；历史基金选基/PIT、真实成交及旧页面逐项验收仍有剩余。冻结只保证复现，不证明历史无超前数据。基准数据更新、整体前端样式和技术架构按计划后置。详见[迁移清单](docs/wiki/FACTOR-MIGRATION.md)。

本批补齐图表日期/区间/框选/缩放、账户收益/回撤、共同窗比较、全部结果查询、实际子因子槽位权重与导出，以及510300归档PE择时复算（分档倍数/现金池/月内买入日/均线与买停标记）。归档复算是只读预览，可下载/载入参数文件，不进入正式配置/请求/结果库或绕过guarded工具。真实浏览器完整操作仍未验收，统一证据和剩余项见[迁移验收](docs/wiki/FACTOR-ACCEPTANCE.md)。

## 当前能力

| 模块 | 已落地 | 边界 |
|---|---|---|
| 投研观察台 | 原生观察面板、来源与配置查询 | 部分明确标记为示例；不是实时行情服务 |
| 研究生产 | Skill、流程和旧产出只读索引 | 不调用模型或执行旧生产任务 |
| 因子实验室 | 定义/子因子编辑、配置、执行请求、结果/账本、图表和历史查询 | 定义入库不等于可计算；不支持的策略明确拒绝 |
| 基金数据层 | 新工作台SQLite、离线增量导入、查询、选定源实验冻结/复算、手动备份/核验/新文件恢复 | 不自动抓取、调度、更新基准或切换数据库；冻结不是PIT |
| 日报 | 保留历史入口 | 日报归档及早晚报生产暂停，不参与默认生产 |
| 知识库、模拟复盘、Lance | 工作区登记 | 核心业务仍待迁入，不是完整可用模块 |

因子已支持原始行业月度TopN、自建行业白名单公式、宽基月/周/双周定投、A/B/C三档月度定投、基金同口径横截面筛选、SQLite手动固定基金篮子历史定投。行业/自建行业支持真实敏感度重跑及代理风险模型；行业和现金流策略分别有账本超额归因。代理模型不是因果Alpha或独立Smart Beta，筛选不是历史基金回测。

## 快速启动

Node.js支持范围见 [package.json](package.json)，当前验证基线为 **24.14.0**，也声明支持22.23.1以上的22.x。Node侧零第三方包，无需 `npm install`。

```sh
git clone --branch release/factor-migration-v1 https://github.com/ivoryshi/invest01.git
cd invest01
npm run check
npm run test:portable
npm start
```

`test:portable`需要Python 3，仅测试隔离数据库维护与源码指纹，不需要原始数据或NumPy。打开 [工作台](http://127.0.0.1:4311/) 或 [因子实验室](http://127.0.0.1:4311/#factors)。服务固定监听本机回环地址，没有认证，不应公开到互联网。Ctrl+C停止；修改后端代码后重启。端口占用可用：

```sh
PORT=4322 npm start
```

没有私有数据的新机器可以启动页面和部分元数据接口，但不能直接执行完整回测；数据缺失不应被理解为策略无效或零收益。`/api/health`只确认进程健康，`dataConnected=false`不等于所有本地数据均未接入。

## Python 与数据准备

回测/CSV与Parquet查询依赖Python、NumPy、pandas、PyArrow，验证版本见 [requirements.txt](modules/factors/requirements.txt)。备份和CSV导入使用标准库。新机器可自行在虚拟环境准备依赖；本次交付未自动安装或替换环境：

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r modules/factors/requirements.txt
```

启动Node服务前激活环境，执行器通过PATH里的 `python3`调用。源码不包含授权行情、基金历史数据库、实验配置/结果、冻结副本或旧实验原件。行业/宽表/研究索引仍有本机绝对路径，尚未全部跨机器配置化；请先阅读[数据准备与维护](docs/wiki/FACTOR-DATA.md)，不要以新造数据替代缺失历史。

现成净值CSV离线转库示例：

```sh
npm run import:fund-history -- --raw-root /absolute/path/to/fund-warehouse/raw
npm run import:fund-history -- --nav-codes 000001 000002 --skip-benchmarks
npm run backup:fund-history -- create
```

这些命令只在明确触发时执行，不重新抓取历史。增量导入以源内容SHA跳过不变数据，更新后旧配置需重新读取源版本。备份是整库复制，先检查磁盘容量；恢复只写新文件，不自动替换活动库。具体参数、返回码和恢复演练见[数据说明](docs/wiki/FACTOR-DATA.md)。

基金历史配置可先读取并绑定份额/基准，再冻结选定数据、保存配置并执行。冻结仅复制1至10个选定份额的完整历史、对应名录和一个基准，单次64MiB上限；结果绑定输入SHA及捕获/执行源码SHA。原库更新不影响已冻结实验；缺失、损坏或篮子/基准不符拒绝，不自动改用最新数据。历史可得时间和数据使用约束见[数据时点协议](docs/wiki/FACTOR-DATA.md)中的“数据时点与比较”。

## 回测工具与 Skill

因子页新增原生回测工具区域，使用已保存配置和冻结数据。先预检，再逐项确认两条模拟限制，才可执行；配置、数据或执行代码变化使预检凭证失效。同一完成凭证复用已有结果，不重复生成实验。旧手工执行入口不能重新执行受保护请求。

```sh
npm run factor:backtest -- catalog --port 4311
npm run factor:backtest -- preflight --config-id config.your_saved_config --port 4311
```

`config.your_saved_config`须替换为实际保存ID。预检不写库或生成收益；`ready=true`不证明完整质量或历史可得性。支持五类已有历史模拟，不把最新基金筛选或旧导出当历史回测。详情见[回测操作手册](docs/wiki/FACTOR-BACKTEST.md)和[项目Skill](.agents/skills/factor-backtest/SKILL.md)；不安装全局Skill，不隐式抓取、建快照、改参数或启动定时任务。

## 开发与验证

```sh
npm run check
npm run test:portable
npm test
npm run factor:acceptance
npm run build
npm run test:observatory
```

完整 `npm test` 包含依赖本机授权数据的集成测试；无数据环境不承诺通过。测试期间不要运行真实实验或并发执行另一轮集成测试，因为部分API测试会暂存/恢复本机运行库。默认构建只更新观察台，不运行日报、抓取或回测。自动测试与真实浏览器操作/视觉验收分别记录。

`factor:acceptance`需要本机数据库/运行文件/原件档案，只发只读查询并核验归档，报告写入本机`var/factors/migration-acceptance/latest.json`、不上传Git；通过状态是`readonly_baseline_passed_acceptance_review_required`，不是整体验收通过。不要与真实实验或全API回归并发运行。

## 文档导航

- [因子实验室说明](modules/factors/README.md)：执行器、公式、结果与边界。
- [数据准备与维护](docs/wiki/FACTOR-DATA.md)：目录、CSV口径、增量导入、冻结、备份恢复。
- [因子API](docs/wiki/FACTOR-API.md)：读写端点、执行步骤与错误处理。
- [回测工具与Skill](docs/wiki/FACTOR-BACKTEST.md)：预检、显式执行、结果复用、审计与停止条件。
- [计算口径](docs/wiki/FACTOR-CALCULATIONS.md)：得分、现金流、收益、归因和误差。
- [开发验收](docs/wiki/DEVELOPMENT.md)、[运维发布](docs/wiki/OPERATIONS.md)、[当前架构](docs/wiki/ARCHITECTURE.md)。
- [迁移清单](docs/wiki/FACTOR-MIGRATION.md)、[短状态](docs/wiki/STATUS-SHORT.md)、[任务](docs/wiki/TASKS.md)、[Wiki](docs/wiki/README.md)。
- [迁移验收矩阵](docs/wiki/FACTOR-ACCEPTANCE.md)：旧功能对应、计算差异、真实操作证据与待收口项。
- [贡献规范](CONTRIBUTING.md)、[安全边界](SECURITY.md)、[来源与许可](THIRD_PARTY_NOTICES.md)、[执行规范](AGENTS.md)。

## 发布边界

只同步源码、测试和文档，`var/`仅保留占位文件。本机旧main包含生成缓存历史，因此新版本继续干净release分支，**不合并旧main，不推送其历史**。没有自动生产部署、认证、后台任务队列或外部灾备。旧项目只读，迁移来源与适配记录见Wiki及来源清单。尚未指定通用开源许可证，公开可见不等于授权再分发数据或所有来源资产。
