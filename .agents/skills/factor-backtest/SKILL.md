---
name: factor-backtest
description: 在投研工作台01执行已有配置的回测预检、显式运行与结果审计，核对冻结数据、配置版本和历史信息可得性。适用于行业、自建行业、三档、宽基定投、基金固定篮子及510300归档PE定投，不用于抓取、实际交易或将最新基金截面反填历史。
---

# 因子回测交接

使用当前仓库的回测工具，复用已保存配置、已有冻结数据和执行器。不运行旧项目脚本、不自动取数、导入、冻结或改参数。创建新配置、变更研究假设与运行真实实验需遵守当前用户授权；Skill可发现不等于允许后台自动运行。

## 数据边界

- 先确认研究对象与范围。当前工具仅支持假设性模拟，不支持经过PIT验证的历史因子选基。基金最新wide_today、经理、规模、费用和持仓不能用于过去决策。
- observationDate、availableAt、importedAt、frozenAt不是同一时间。没有真实披露/修订证据时，availableAt未知；冻结与后向窗口不证明无前视或幸存者偏差。
- 只能使用配置已绑定的冻结版本。缺失、损坏或选择不符停止；不得偷偷改成current、补价格/数据或伪造来源SHA。
- 将模拟费用、指数/净值代理、申赎/实际成交缺口保留在结论中。账本归因与代理回归不是因果Alpha或可投资Smart Beta证明。
- 510300 PE仅执行已冻结归档及正式保存参数；预览无requestId/artifactId，不作为正式执行回执。估值观测滞后与归档VWAP不证明PIT或实时可成交；free模式实际投入不同，不按期末财富排名，分别使用XIRR。不可经旧手工execute绕过确认。

具体字段或口径不清楚时，按需读[数据说明](../../../docs/wiki/FACTOR-DATA.md)、[API](../../../docs/wiki/FACTOR-API.md)或[计算口径](../../../docs/wiki/FACTOR-CALCULATIONS.md)，不要每次读取全部历史任务和原文件。

## 工具链路

在仓库根运行，默认4311；若用户使用其他本地服务，传已确认端口。工具仅连127.0.0.1，不启动服务或访问外部地址。

```sh
npm run factor:backtest -- catalog --port 4311
npm run factor:backtest -- preflight --config-id config.saved_id --port 4311
```

config.saved_id是占位，必须使用用户指定或当前配置库中明确选定的ID。没有ID时先只读查询配置，不从最好收益反推要运行的配置，也不擅自变更策略。preflight读取参数和冻结内容，不运行收益模拟、不写请求/结果。

预检ready=true也不是数据全量质量/PIT通过。读取scope、blockers、validation、configRevision、snapshotId及requiredAcknowledgements。ready=false停止并报告具体缺口；PIT要求使用researchMode=point_in_time_verified，只会得到拒绝，不能自行降级假设模拟。

仅在用户已授权执行该实验，并明确接受预检列出的假设范围时，使用刚核对的preflightSha256与逐项确认值：

```sh
npm run factor:backtest -- run --config-id config.saved_id --port 4311 \
  --preflight-sha256 RECEIPT_SHA256 --confirm-execution \
  --acknowledge not_point_in_time_verified,proxy_or_adjusted_nav_not_real_execution
```

RECEIPT_SHA256也是占位，不编造。凭证绑定完整配置/revision、冻结身份、校验/计算/交接程序版本和研究模式；配置、数据或程序变化需重新预检并确认，不直接替换SHA继续。工具不会自动保存草案、冻结、改参数或提高收益。

收到结果后：

```sh
npm run factor:backtest -- audit --artifact-id result.returned_id --port 4311
```

使用真实artifactId。核对请求/结果关联、配置revision、数据与计算指纹、预检凭证、账本及已有归因闭合。audit只查存储结构，不重算收益或核验PIT；review_required不是投资结论。完整曲线/账本从结果详情读取，不用控制台摘要冒充完整资产。

## 停止与交付

命令返回0表示当前操作完成，2表示预检阻断/审计不完整，1表示参数/HTTP/环境错误。409或超时停止，先只读检查请求和结果，不能自动重跑、换ID、改参数、忽略限制或创建后台任务。相同已完成凭证复用结果；两JSON存储不是数据库事务，部分写入需人工复核。

交付真实configId/revision、snapshotId、preflightSha256、requestId、artifactId、指标与审计状态、费用/基准/频率和数据时点限制。缺失收益、IRR或归因留空；不把null写成0，不对不可比数据排名，不声称全部迁移或历史无前视已完成。
