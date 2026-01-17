# 料品主数据 (Item Master) - 开发者详尽指南

## 概述
料品（Item）是 ERP 系统的“细胞”。在多组织、多工厂环境下，料品不仅包含基础物理属性，还承载了复杂的**计划参数**、**计量规则**和**追溯要求**。开发者必须利用数据库的**全文检索**、**高精度计算**和**文档型存储**特性，确保料品数据的灵活性与严谨性。

---

## 1. 料品检索与分类 (Search & Classification)

### 业务场景
制造企业中常有“一物多名”现象。采购部、工程部和供应商对同一料品的称呼可能完全不同。开发者需要提供极速且模糊的全局检索能力。

### 技术实现建议
    - 针对料品名称、规格、别名等字段，推荐使用 PostgreSQL 的 **GIN 索引** 配合 `trgm` (trigram) 模块，实现高性能的模糊匹配（`LIKE '%keyword%'`）。
    - 对于海量料品数据，可引入 **全文检索 (Full Text Search)**，支持权重排序，提升用户查找料品的效率。
    - **示例代码**:
      ```sql
      -- 创建 trigram 索引优化模糊搜索
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX idx_item_name_trgm ON item_master USING gin (name gin_trgm_ops);
      -- 搜索包含 'Steel' 的料品
      SELECT * FROM item_master WHERE name ILIKE '%Steel%';
      ```

---

## 2. 计量单位与高精度换算 (UOM & Conversion)

### 业务场景
“1吨钢材出库后，变成了 0.9999 吨”。这种误差通常源于换算率精度不足或不正确的存储基准。

### 开发规范
- **主单位基准**: 所有库存结存、财务核算必须以“主单位”为唯一基准。
- **双单位计量**: 针对农产品（如：按“件”入库，按“公斤”结算），需同时记录两个维度的数量。
- **技术实现建议**: 
    - 换算率必须定义为 `numeric(24, 12)`，确保在多次换算后不丢失精度。
    - **JSONB 扩展**: 对于非线性的、复杂的换算规则（如根据温度、密度动态换算），可将换算算法参数存储在 `JSONB` 字段中。
    - **示例代码**:
      ```sql
      -- 开发者需设计 `SecondQty` 字段存储辅助单位数量
      ALTER TABLE inv_onhand ADD COLUMN second_qty numeric(24, 12);
      ```

---

## 3. 属性扩展：EAV 与 JSONB 的取舍

### 业务场景
不同行业的料品属性差异极大。服装行业需要颜色/尺码，化工行业需要纯度/粘度，电子行业需要封装/版本。

### 开发规范
- **核心属性静态化**: 编码、名称、单位等通用属性应作为表字段。
- **行业属性动态化**: 针对行业特有属性，避免频繁修改物理表结构。
- **技术实现建议**: 
    - 弃用性能低下的 EAV 模式（属性-值表），全面转向 **JSONB** 存储扩展属性。
    - **约束增强**: 利用 PostgreSQL 的 **JSON Schema 校验** 或触发器，确保存入 `JSONB` 的属性符合行业定义的规范。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 存储行业属性并配置 GIN 索引
      CREATE INDEX idx_item_props ON item_master USING gin (industry_props);
      -- 查询红色且尺码为 XL 的料品
      SELECT * FROM item_master WHERE industry_props @> '{"color": "Red", "size": "XL"}';
      ```

---

## 4. 追溯控制：批次与序列号 (Lot & SN)

### 业务场景
医药、汽车行业要求全生命周期追溯。必须能从一张成品单据穿透到其所有原材料的供应商批次。

### 开发规范
- **强控开关**: 料品主档应设置 `IsLotControl` (批次控制) 和 `IsSNControl` (序列号控制) 开关。
- **先进先出**: 建议库位时应自动匹配最早入库的批次。
- **技术实现建议**: 
    - 批次属性（生产日期、失效日期、质检状态）推荐存储在 `JSONB` 中。
    - 利用 PostgreSQL 的 **Recursive CTE (递归公用表表达式)** 实现 BOM 级的追溯查询，快速反查某一有问题原材料影响的所有成品订单。
    - **示例代码**:
      ```sql
      -- 递归追溯批次来源
      WITH RECURSIVE lot_trace AS (
          SELECT lot_id, parent_lot_id FROM lot_genealogy WHERE lot_id = :target_lot
          UNION ALL
          SELECT g.lot_id, g.parent_lot_id FROM lot_genealogy g
          JOIN lot_trace lt ON g.lot_id = lt.parent_lot_id
      )
      SELECT * FROM lot_trace;
      ```

---

## 5. 开发者 Checklist

- [ ] **高效检索**: 料品搜索字段（名称、规格）是否配置了 `gin_trgm_ops` 索引？
- [ ] **精度对齐**: 换算率和单位数量字段是否统一使用 `numeric` 类型？
- [ ] **动态属性**: 行业扩展属性是否采用了 `JSONB` 存储，并配置了 GIN 索引以支持属性过滤？
- [ ] **状态校验**: 在单据 Service 层，是否强校验了料品的状态（如：禁止在“停用”状态下录入采购单）？
- [ ] **级联删除**: 料品停用/删除前，是否利用数据库函数快速检查了在途单据（SO/PO/MO）的引用？
