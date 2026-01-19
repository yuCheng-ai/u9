# 自研 ERP 产品细节规格文档 (竞争 U9)

本系列文档详细记录了为对标并竞争用友 U9 而设计的自研 ERP 系统产品细节。文档涵盖了从核心多组织架构到各业务模块的详细菜单、功能点及核心业务逻辑。

## 核心架构
- [核心业务架构与多组织逻辑](./guide/introduction.md)

## 业务模块详情
- [CBO 基础设置](./modules/cbo/common-base.md) - 料品、组织、合作伙伴等主数据。
- [SCM 供应链管理](./modules/scm/sales-process.md) - 采购、销售、库存、质检。
- [MFG 生产制造](./modules/mfg/bom-manage.md) - BOM、MRP、生产订单、车间。
- [FI 财务管理](./modules/fi/gl-ar-ap.md) - 总账、报表、应收应付、固定资产。
- [COST 成本管理](./modules/fi/cost-std.md) - 成本域、实际成本核算。
- [PBM 项目制造](./modules/feature/pjm.md) - 针对项目型企业的专项方案。
- [SYS 系统管理](./modules/sys/uap.md) - 平台、集成、云服务。

## 设计目标
1. **多组织协同**：支持复杂的集团化、全球化经营。
2. **业财一体化**：通过自动会计平台实现业务与财务实时同步。
3. **精细化成本**：提供料品级、工序级的成本核算与分析。
4. **敏捷制造**：支持 MRP/LRP 等多种计划模式，快速响应市场变化。
