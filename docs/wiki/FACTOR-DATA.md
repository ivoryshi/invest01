# 因子数据准备与维护

本页说明v0.5.3的数据边界。回测只使用已有授权数据，不隐式抓取。原始项目和旧fof.db只读。数据库、CSV/Parquet、冻结、备份和历史副本不上传Git，也不通过任意静态路径公开。

## 数据位置

| 数据 | 当前位置/用途 | 可迁移性 |
|---|---|---|
| 工作台历史库 | 当前仓库var/factors/fund-history.sqlite | 已按仓库位置定位 |
| 净值导入来源 | /Users/samshi/Projects/fund-warehouse/raw | 导入可用--raw-root或FUND_HISTORY_RAW_ROOT |
| 基金截面 | /Users/samshi/Projects/fund-warehouse/wide_today.csv | 当前仍为contracts绝对路径 |
| 行业与三档 | /Users/samshi/Desktop/My Claude/etf-smartbeta/data | 当前仍为contracts绝对路径 |
| 旧导出/原页面 | 同旧项目out及HTML | 只读查询或显式归档，不执行 |
| 备份包 | 默认var/factors/database-backups/backupId | create可指定外部output-dir |

来源引用见[数据契约](../../packages/contracts/factors.js)与[API服务](../../apps/api/server.js)。除净值导入源外，尚无统一DATA_ROOT环境变量；切勿声称一次设置就迁移全部路径。研究只读索引另有旧路径。跨机器迁移需逐项提供授权源并修订路径/做回归，不上传真实源文件。

## 净值CSV最小口径

目录结构：

```text
raw/
  universe_master.csv
  nav/000001.csv
  bench/CSI300.csv
```

- 名录：share_code（六位字符串、唯一）、share_name（非空）；其他列按原metadata保留。
- 净值：date、adj_nav、unit_nav、source、adj_method、freq。日期为唯一ISO日；adj_nav有限正值，unit_nav允许空但非空须为正；全文件source/adj_method/freq一致。
- 支持组合：offex_unit + self_calc，或onex_hfq + hfq；freq为日频或非日频。可导入非日频不代表历史篮子执行器可运行，执行时还检查实际日期频率。
- 基准：date、close（有限正值）、kind（全收益或价格）、source_code（全文件一致）。只接受已登记基准ID，不自动创建自定义指数。
- 单源上限：名录16MiB，其余4MiB；至少名录1行、时间序列2行。BOM按utf-8-sig解析；截断/重复/异常不默默填补。

这里是schema说明，不提供可冒充真实行情的示例收益序列。原分红/复权方式沿用来源，未重新逐笔核验分红。

## 离线导入与增量维护

首次或全目录重读：

```sh
npm run import:fund-history -- --raw-root /absolute/path/to/raw
```

数据库固定写当前仓库，来源通过参数或FUND_HISTORY_RAW_ROOT选择；不允许HTTP传任意路径/SQL。默认扫描已有六位净值文件和已存在的登记基准。每次仍检查名录，不抓取数据。

只更新两个已经准备好的净值文件，保留现有基准：

```sh
npm run import:fund-history -- --raw-root /absolute/path/to/raw --nav-codes 000001 000002 --skip-benchmarks
```

只读入明确指定的已有基准，净值限定一个份额：

```sh
npm run import:fund-history -- --raw-root /absolute/path/to/raw --nav-codes 000001 --benchmark-ids CSI300
```

skip-benchmarks与benchmark-ids互斥。**读入已有基准CSV不是更新脚本，也不延伸覆盖范围。** 指定缺失文件记录rejected，保留旧库对应源；不删除旧记录。默认全扫描也不会删除已导入但如今不在目录中的份额，因此状态统计不是原始目录现状。

内容SHA不变则skipped；变更源先完整解析，再逐源事务替换净值与SHA，异常源保留上一个成功版本，其他源继续。不是全批次原子事务。报告含lastImport、imported/skipped/rejected和异常样本；完整异常在import_errors。退出码0=无拒绝，2=完成但有拒绝；启动/名录/程序错误为非零。CLI持有非阻塞导入锁；另一个导入/备份正在运行时拒绝，不创建定时任务。

外部CSV变动不会自动生效。成功导入改变源SHA后，旧实验配置执行返回409；在页面重读profile，确认覆盖/复权/基准后另存或修改配置。新代码不自动修订用户历史配置。

## 整库备份与核验

备份需要额外整库空间；先确认磁盘/目标介质。SQLite online backup包含已提交WAL，不能只手工复制活动库的.sqlite文件。

```sh
npm run backup:fund-history -- create
npm run backup:fund-history -- create --output-dir /absolute/path/to/external-backups
```

create默认读取工作台库，和CLI导入共用锁。输出JSON包含backupId和payload；包在output-dir/backupId内，含database.sqlite、manifest.json。payload记录格式/schema、完整文件SHA/字节数、导入状态、源表摘要和源版本指纹；身份包含payload但不含创建时间。SQLite重新备份可能改变文件头，所以逻辑相同不保证同backupId。

发布前暂存目录完成后重命名；同身份已存在则核验复用，不偷偷修补。失败清理本次暂存，不删除已有包。禁止符号链接路径；macOS用真实路径/private/tmp或/private/var而不是/tmp、/var链接别名。

```sh
npm run backup:fund-history -- verify /absolute/path/to/backups/backupId
```

核验包括清单身份/目录名、SHA/字节、SQLite integrity_check、schema和源指纹/摘要；带WAL/SHM/journal的非独立包拒绝。清单/内容都可被持有写权限者重写，SHA是完整性校验，不是签名或第三方真实性证明。核验大库可能耗时；此API不在页面加载时自动全库扫描。

## 恢复演练

```sh
npm run backup:fund-history -- restore /absolute/path/to/backups/backupId --output /absolute/path/to/recovered.sqlite
```

只能写不存在的新文件，已有目标或其sidecar拒绝；对真正复制的字节重新核验后原子发布，不覆盖正在运行的库。符号链接与损坏拒绝，失败清理临时文件。CLI不会自动切换服务或删除当前库。

正式切换需停止服务与导入任务，核验恢复文件、覆盖、异常与典型回测，再由维护者另行批准替换方案并保留旧库。当前只通过隔离fixture的WAL/损坏/恢复演练，**没有复制真实大库、自动外部备份、跨机灾备或定期恢复验收**。请勿把本机第二副本当外部灾备。

## 实验冻结与旧档案

冻结API适用于已支持的基金截面/宽基/三文件行业/八文件三档包，以及基金SQLite选定源。缺失或损坏返回错误，不回退current。整库备份不能代替选定实验snapshot。

基金历史配置：先选择1至10个份额和一个基准，读取profile绑定sourceVersions，然后“冻结已绑定基金数据”，显式保存配置、创建请求并执行。数据版本下拉可选择现存冻结版本，打开旧配置保留原ID；若当前库不可用且有合法冻结清单，表单允许从冻结版本读取。列表只查清单，profile和执行会实际校验内容。

捕获从一个SQLite读事务复制选定份额的完整历史、对应名录、一个基准和原导入凭证到独立schema=1数据库。不复制全库或import_runs/import_errors，不因不变源重读而产生新版本。单包最多64MiB，超限或凭证变化拒绝并清理临时副本；不触发抓取。基金codes顺序规范化，篮子/基准不符拒绝profile和执行，不能将同snapshot改成另一个篮子。

snapshot.frozen身份绑定选定codes/benchmarkId/sourceVersions、实际SQLite字节SHA/大小及捕获程序/依赖SHA。sourceVersions是原CSV导入凭证，不是整个冻结SQLite的SHA；结果同时保存两者及实际执行源码指纹。捕获程序指纹变化可产生新身份，即使数据逻辑相同。名录原凭证属于全名录，但冻结只含选定行，统计单独注明不等于全库来源数。

运行先校验清单与文件，再对真正读取的同一字节重新校验SHA并反序列化到只读内存SQLite，避免校验后文件路径被替换。活动库之后更新、移动或删除不影响冻结复算。只复现数据输入；没有自动保留/执行旧解释器或环境，跨源码/依赖版本的数值复现仍需核对结果中的版本。SHA不是签名，也不证明供应商数据真实或历史可得。

```sh
npm run archive:factor-legacy
npm run archive:factor-legacy -- --verify
```

显式只读捕获当前旧导出13文件，版本化字节和标准记录；latest61条不等于全部历史实验。旧HTML不执行或嵌入，静态默认值不能当实际历史参数。GET清单只验身份，不替代verify逐文件SHA。

## 数据时点与比较

基金净值最晚2026-09-30、基准最晚2026-07-31为上批本机验收记录，不保证新机器/后来导入仍相同；以当前profile为准。共同覆盖不足拒绝，不补价。最新wide_today不能用于历史择优；历史横截面、财务披露可见日和宏观修订史仍缺。不同snapshot/成本/基准/频率不能直接排名。更多限制见[计算口径](FACTOR-CALCULATIONS.md)。

长期数据使用协议沿用现有存储和执行器，暂不新增数据库/框架。将以下时间和版本分开：

| 含义 | 现有记录或约束 |
|---|---|
| observationDate | 净值date、统计所属期；仅说明观测对象日期 |
| availableAt | 该版本最早真实公布/可获得时间；现有基金输入没有，必须记未知 |
| importedAt | 数据导入记录；不代表过去的可得时间 |
| frozenAt | 清单createdAt；仅证明本次捕获时刻，不代表历史截面 |
| revision/source version | 原数据SHA、冻结字节SHA与程序指纹；修订需保留版本，不把新值反填旧结果 |

Agent先区分“现时筛选”“手动篮子历史模拟”“PIT历史因子选择”。基金profile与结果提供temporalEligibility.status=not_point_in_time_verified、historicalFactorSelectionAllowed=false，执行器拒绝因子选择配置；不能只改备注解除约束。最新经理、规模、费用、持仓或名录不进入过去的决策。已落地的后向窗口/信号滞后防止使用未来观测值，但没有真实披露与修订时点时，不宣称全部无前视。

当前[回测工具与Skill](FACTOR-BACKTEST.md)已要求读取上述限制、保存配置revision、冻结输入和源凭证后预检，并须明确授权与确认假设才执行。要求point_in_time_verified会阻止运行，不自动降级。PIT查询未来需要同时满足observationDate与availableAt不晚于决策时刻，并按当时可见修订版本选择。该查询尚未实现，不用伪造availableAt或一律加一天代替真实证据。数据抓取仍采用显式增量与原件保留，未经确认不启动定时任务或重抓历史。
