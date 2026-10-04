# 因子API

版本v1，服务默认http://127.0.0.1:4311；没有认证，只供本机可信单用户使用。写入Content-Type为application/json。不支持DELETE。请求体上限/字段/参数以[server.js](../../apps/api/server.js)及对应执行器为准；本页不把候选注册API当已执行引擎。

## 端点清单

以下路径均以 `/api/modules/factors/v1` 为前缀，GET通常也支持HEAD。

| 路径 | 方法 | 行为 |
|---|---|---|
| /assets、/snapshots、/definitions、/artifact-candidates | GET | 来源/候选/定义登记 |
| /library | GET | 内置及本地提交定义合并查询 |
| /library/submissions | GET、POST | 查询/新增本地因子定义 |
| /library/submissions/{factorFamilyId} | GET、PUT | 单条查询/修改 |
| /experiment-configs | GET、POST | 草案和templates/新增 |
| /experiment-configs/{configId} | GET、PUT | 单条草案/修改revision |
| /custom-expression/options | GET | 字段/函数及已注册程序 |
| /custom-expression/validate | POST | executionSpec校验，不保存 |
| /custom-expression/preview | POST | config同日定位试算，不生成结果 |
| /industry-engine/options、/three-bucket-engine/options | GET | 支持参数和固定定义 |
| /backtest-engine、/execution-plan | GET | 引擎/就绪检查，不执行 |
| /run-requests | GET、POST | 请求查询/从已存configId创建 |
| /run-requests/{requestId}/execute | POST | 同配置revision实际执行 |
| /result-artifacts、/result-artifacts/{artifactId} | GET | 新结果列表/详情与复核清单 |
| /fund-screen/options、/fund-screen/profile | GET | 宽表同口径组、字段和源版本 |
| /fund-nav/catalog?q= | GET | SQLite份额名录搜索 |
| /fund-nav/profile?codes=000001,000002&benchmarkId=CSI300 | GET | 选定净值/基准覆盖和源SHA |
| /data-layer、/data-layer/schema、/data-quality | GET | 数据登记/字段/质量说明 |
| /data-layer/preview | GET | 有界样本，非全表质量结论 |
| /snapshots/frozen | GET、POST | 冻结列表/捕获支持的baseSnapshotId |
| /snapshots/frozen/{snapshotId}/verify | POST | 支持冻结包的字节核验 |
| /legacy-archives | GET | 不可变旧档案版本 |
| /legacy-archives/{archiveId} | GET | q/category/sourcePath/offset/limit查询 |
| /legacy-experiments、/visual-lab、/experiment-comparison | GET | 旧导出映射与对比 |
| /lab-framework、/product-state | GET | 产品框架及当前状态，不启动任务 |

其他核心入口：GET /api/health、/api/workspaces、/api/contracts/v1/core、/api/contracts/v1/factors、/api/registry/v1/*；观察台/研究/日报有各自命名空间，见当前架构。

## 定义和配置约束

定义字段包括factorFamilyId、title、universe、category、frequency、sourceAssetIds、snapshotIds、fields、计算/使用逻辑及版本；字段说明须包含公式、方向、缺失策略、定义。自建定义额外executionSpec，子节点与展示字段必须逐项对应，服务校验后记录executionSha256。

配置包括configId、title、strategyTemplateId、snapshotId、universe、factorFamilyIds、factorWeights、benchmarkId、portfolioRule、rebalanceCalendar、costModel、constraints、comparisonLimits、strategySettings/transactionSettings。应从当前templates或原生表单获取完整字段，不拼凑只含ID的请求。某些通用草案可保存但不能执行，执行阶段严格拒绝不支持规则。

自建factorProgram必须引用已注册或已保存历史revision和executionSha256；不是客户端任意填入的“证明”。修改定义不改变配置中的公式副本。基金篮子需先profile读取sourceVersions；筛选也需读取源SHA与严格comparisonGroup。

## 最小执行交接

已有合法config后：

```sh
curl -s http://127.0.0.1:4311/api/modules/factors/v1/execution-plan
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"configId":"config.your_saved_config"}' \
  http://127.0.0.1:4311/api/modules/factors/v1/run-requests
curl -s -X POST \
  http://127.0.0.1:4311/api/modules/factors/v1/run-requests/run.RETURNED_ID/execute
```

config.your_saved_config与run.RETURNED_ID为占位，使用真实已保存ID。请求创建响应JSON的item.requestId为完整运行ID，原样用于执行URL；执行成功返回resultArtifact，详情保存完整口径/警示。创建请求不自动执行，执行不是后台排队服务。不要重复点击或并行写相同库；当前JSON持久化不是多用户事务数据库。

公式校验正文为 `{"executionSpec": ...}`，preview正文为 `{"config": ...}`，完整合法样例与负例见[API测试](../../tests/server.test.js)及[公式测试](../../tests/factor_expression_test.py)。省略号不是有效JSON。

## 错误与限额

| 状态 | 常见含义 | 处理 |
|---|---|---|
| 400 | URL/JSON/基础请求格式无效 | 修正请求，不自行降级 |
| 404 | 路径/ID/公开资产不存在 | 核对真实ID；var与数据库不公开 |
| 405 | 方法未开放 | 使用端点支持的方法 |
| 409 | 源/配置版本变化、冻结字节冲突 | 重读数据版本并确认新配置；损坏冻结不要换current冒充 |
| 422 | 策略/公式/参数/数据口径不支持 | 检查error和options，不伪填缺失价格或历史因子 |
| 500 | 查询/环境/读取异常 | 查本地日志、Python环境和源路径，不视为零收益 |

不同入口可能将底层错误映射到不同状态，必须同时读取error，不仅按状态猜原因。只拒绝执行不代表草案会被删除。历史列表limit最多100、关键词100字；数据预览最多50返回行和每页后续5000检查行，不代表全样本。算式/回测timeout与输出上限由执行器控制。

databaseMaintenance只登记手动离线命令，不存在HTTP“执行更新/备份/恢复”接口。工具见[数据维护](FACTOR-DATA.md)，不把命令登记当后台任务已完成。
