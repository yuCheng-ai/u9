# 料品主数据 (Item Master) - 开发者详尽指南

## 概述
料品（Item）是 ERP 系统的“细胞”。在多组织、多工厂环境下，料品不仅包含基础物理属性，还承载了复杂的**计划参数**、**计量规则**和**追溯要求**。开发者必须利用数据库的**全文检索**、**高精度计算**和**文档型存储**特性，确保料品数据的灵活性与严谨性。

---

## 1. 料品检索与多语言主数据 (Search & Multi-language)

### 业务场景
制造企业中常有“一物多名”现象，且全球化企业要求料品名称、规格在不同语种（中文、英文、日文）下均有对应存储。开发者需要提供极速检索及多语种动态切换能力。

### 技术实现建议
- **多语言存储模型**: 弃用“多列模式”（name_en, name_zh），推荐采用**中间表模式**或 **JSONB 模式**。
    - **中间表模式**: `item_master_lang` 表存储 `item_id`, `lang_code`, `field_name`, `field_value`。适合字段极多且需频繁扩展语种的场景。
    - **JSONB 模式**: 在 `item_master` 中定义 `name_i18n` (JSONB) 字段，存储 `{"zh": "钢板", "en": "Steel Plate"}`。
- **高性能模糊检索**:
    - 针对 `JSONB` 中的多语种字段，推荐使用 PostgreSQL 的 **GIN 索引** 配合 `jsonb_path_ops`。
    - 配合 `trgm` (trigram) 模块，实现对 JSON 内部文本的高性能模糊匹配。
- **示例代码**:
  ```sql
  -- 使用 JSONB 存储多语言名称
  SELECT name_i18n->>'en' FROM item_master WHERE id = :id;
  
  -- 创建索引优化多语言模糊搜索
  CREATE INDEX idx_item_name_i18n ON item_master USING gin (name_i18n);
  ```

---

## 2. 计量单位与变动换算率 (UOM & Variable Conversion)

### 业务场景
- **固定换算**: 1 盒 = 10 支（文具行业）。
- **变动换算 (Variable Conversion)**: 针对农产品或化工行业，存在“非固定比例双单位换算”。例如：入库时按“件”，出库时按“重量”，但每件的重量由于水分挥发或个体差异并不固定。

### 开发规范
- **双单位强校验**: 针对设置了“变动换算”的料品，单据录入时必须强制用户同时输入两个单位的数量。
- **换算率动态计算**: `Rate = Qty1 / Qty2`。系统需记录每笔业务发生时的“实际换算率”，而非仅使用主档的“标准换算率”。
- **技术实现建议**: 
    - 换算率必须定义为 `numeric(24, 12)`。
    - **库存余额**: `inv_onhand` 必须同时存储 `Qty` (主单位) 和 `SecondQty` (辅助单位)，防止因换算率波动导致的“账实不符”。
- **示例代码**:
  ```sql
  -- 每一行明细需存储交易时的实际换算率
  ALTER TABLE inv_trans_line ADD COLUMN actual_conversion_rate numeric(24, 12);
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
