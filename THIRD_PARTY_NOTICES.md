# 来源、数据与许可说明

本仓库尚未指定通用开源许可证；仓库公开可见不等于获得源码、第三方资料或行情数据的无限再分发许可。不要擅自为全部内容添加MIT等许可。外部数据、来源资产及复用代码的具体使用权限由维护者确认。

## 来源登记

观察台/日报历史复制清单见[copy-manifest-A01.json](docs/wiki/records/copy-manifest-A01.json)，迁移决策与边界见[批准记录](docs/wiki/records/APPROVALS.md)。当前日报生产暂停，原始归档不随本版源码上传。

因子XIRR复用原etf-smartbeta/src/report.py算法，源文件SHA及适配差异见[migration-provenance.json](modules/factors/src/migration-provenance.json)：无解返回null、保留-0.95至3.0边界与200次二分、记录警示。其余旧脚本候选只登记不自动执行；原始项目保持只读。

原数据来自维护者本机fund-warehouse与etf-smartbeta的已有授权源，CSV/Parquet/SQLite/旧HTML/实验副本不在发布范围。指数代理与基金复权方式仍保留来源限制，不因转库或归档获得新许可。

## 运行依赖

Node侧没有npm第三方依赖。Python执行使用NumPy、pandas、PyArrow，其版本记录在[requirements.txt](modules/factors/requirements.txt)；本仓库没有打包这些依赖源码或许可证文件。使用/分发运行环境时另行遵守各上游许可。本页是来源索引，不替代完整法律许可核验。

新增论文、业界因子、资料或供应商接口时，登记原链接/出处、日期/版本、使用范围与必要的许可说明；不把来源标注当可再分发授权。
