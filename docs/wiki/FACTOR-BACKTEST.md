# 回测工具与 Skill

v0.5.6 / 因子V0.22。复用已有执行器和snapshot/config/request/result链路，不运行旧脚本，不新增依赖。入口为因子页的回测工具区域、项目内[Skill](../../.agents/skills/factor-backtest/SKILL.md)及本地CLI。Skill随仓库分发，不安装到全局目录。运行要求和源码版本见[发布基线](records/FACTOR-RELEASE-V056.md)。返回[Wiki](README.md) / [因子模块](../../modules/factors/README.md)。

## 支持范围

| strategyTemplateId | 实际模拟 | 必须冻结的输入 |
|---|---|---|
| strategy.fund_nav_fixed_dca | 手动固定基金篮子定投 | 选定份额/名录/单基准SQLite |
| strategy.industry_parquet_monthly_topn | 行业月度TopN | panel/bench/investable三文件 |
| strategy.custom_industry_expression | 注册白名单公式行业TopN | 同上，配置绑定程序revision/SHA |
| strategy.legacy_three_bucket_monthly | A/B/C三档月度定投 | 八文件执行包 |
| strategy.monthly_dca_three_bucket | 固定宽基定投 | broad文件 |
| strategy.legacy_510300_pe_dca | 510300 PE分位档位定投 | 明确归档ID/SHA的安全HTML数据副本 |

基金最新横截面筛选、旧panel.json兼容执行和旧导出回放不属于此受保护历史工具。相关旧入口保留，但不被Skill调用或包装为新历史结果。

510300原生表单选择归档后显式冻结，再保存/修改正式配置；从统一回测工具选择该配置、只读预检、双确认后执行。预览仍只读，不自动入库。正式结果保存完整参数/revision、归档/SHA、冻结清单、计算源码与工作流凭证、全账本/现金流/交易和分别计算的XIRR，进入标准请求/结果查询、对比、导出及结构审计。未知基准、费用字符串与实际参数不符、错误归档绑定、过期凭证或缺确认拒绝；PE不能经旧手工execute入口执行。配置保存本身不保证可计算，必须预检并核对结果；未PIT与VWAP假设不因正式入库消失。

所有策略当前只允许`assumption_simulation`：代理指数/复权净值不是实际成交或申赎确认，冻结不证明PIT。`point_in_time_verified`可用于预检要求，但当前返回`historical_information_availability_not_verified`，禁止执行，不能自动降级。最新基金属性不能用来历史选基；观察日期、披露可得日期、导入/冻结日期必须分开。详见[数据时点协议](FACTOR-DATA.md)中的“数据时点与比较”。

## 操作流程

1. 用户先保存完整配置、选择并冻结正确输入，得到实际configId；工具不会代建配置、快照或抓取数据。
2. 只读预检核验策略/参数/冻结身份与字节，使用实际执行器的验证函数，但不运行模拟或写研究库。基金额外核对选择、源版本和共同覆盖；Parquet全部字段、日历及可计算性由实际执行器继续检查。
3. 用户明确授权本次实验，逐项确认两条限制，再提交原样预检SHA。配置revision、源内容、验证代码、执行主/依赖代码或调用代码变化都必须重新预检和确认。
4. 实际执行成功后保存请求、结果及workflowReceipt，返回结构审计。同一完整凭证复用已有完成结果，不重算；复用不是重新验证投资结论。
5. 查结果和原始账本复核。结构审计不重跑计算，不验证供应商真实性、完整数据质量、无前视或因果Alpha。`review_required`仍待研究复核，`incomplete`需排查，不补零。

CLI仅连接本机127.0.0.1指定端口，禁止重定向；默认4311，服务未启动时只报错，不代启动或改配置。实际预览端口以[每日记录](records/DAILY.md)为准。

```sh
npm run factor:backtest -- catalog --port 4311
npm run factor:backtest -- preflight --config-id config.your_saved_config --port 4311
npm run factor:backtest -- preflight --config-id config.your_saved_config --research-mode point_in_time_verified --port 4311
```

只有得到用户明确授权、允许假设模拟且预检ready后才执行下列命令。ID和RETURNED_SHA是占位，使用上一步实际返回值；不能复制固定假SHA跳过检查。

```sh
npm run factor:backtest -- run --config-id config.your_saved_config \
  --port 4311 --research-mode assumption_simulation \
  --preflight-sha256 RETURNED_SHA --confirm-execution \
  --acknowledge not_point_in_time_verified,proxy_or_adjusted_nav_not_real_execution
npm run factor:backtest -- audit --artifact-id result.returned_id --port 4311
```

退出码：0表示请求成功（仍有研究限制）；2表示预检被阻止或结构审计不完整；1表示参数/网络/HTTP异常。每个命令拒绝不适用或重复选项；不自动重试、不挑最优参数、不自动删除失败记录。

## API 与凭证

前缀`/api/modules/factors/v1/backtest-tools`：GET目录，GET `/skill`读取固定项目Skill正文；GET `/preflight?configId=...&researchMode=...`；POST `/run`；GET `/audit?artifactId=...`。完整端点与异常见[API](FACTOR-API.md)。

执行正文只允许configId、researchMode、preflightSha256、acknowledgements，最后一项必须为上述两个唯一字符串，不接受通用true或多余项。服务从已保存配置读取参数，不接受正文覆盖因子/日期/金额。执行前后重新核对凭证；实际捕获的计算源码必须匹配预检。receipt记录协议版本、SHA、配置revision、快照ID、研究模式和确认项。

审计检查配置revision、冻结绑定、源/计算指纹存在、凭证与请求结果链接、指标有限值/账本日期，以及已有归因闭合容差。这是保存资产的结构检查，不是结果文件的数字签名或独立重算证明。计算方法和误差见[计算口径](FACTOR-CALCULATIONS.md)。

## 失败与持久化边界

- 409源/配置/代码变化：停止，读取原因，重新核对并获确认；不得直接换current、改参数或连续重试。
- 所有因子API写请求受单进程写入保护，重叠请求409；多个服务进程不共享锁，不能并发操作同一研究库。
- 完成请求禁止经旧`run-requests/:id/execute`重跑，必须使用回测工具协议；旧手工请求仍属于原流程，不自动转成受保护资产。
- 请求/结果分开JSON文件，不是事务。结果已写但请求失败时重试返回`workflow_partial_write_review_required`，只读检查现有资产后人工处理，不生成另一个ID掩盖问题。
- 读取研究库JSON损坏返回503，不将其当空库覆盖。超时/断连先查询请求结果，不能推断没有完成后直接重跑。

没有认证、多用户任务队列、后台调度、真实成交、PIT查询或自动发布。原数据和测试状态不上传Git。前台双确认是交互约束，API确认项是协议声明，并不证明调用者身份或外部批准。
