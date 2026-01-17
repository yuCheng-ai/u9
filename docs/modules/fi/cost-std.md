# 标准成本与差异分析 (Standard Costing) - 开发者详尽指南

## 概述
标准成本（Standard Costing）是企业的“财务预算”。开发者需要构建一套能够模拟、计算并对比的系统。其核心不在于记录一个数值，而在于**差异的实时捕捉**。

---

## 1. 标准成本的卷积逻辑 (Cost Rollup)

### 企业痛点
**“算一个成品的标准成本要半天”**。BOM 结构复杂，物料成千上万，人工维护标准成本是不可能的。

### 开发逻辑点
- **物料清单 (BOM) 穿透**: 开发者需实现递归算法，提取料品主档中的“标准采购价”，结合 BOM 中的“标准用量”，以及工艺路线（Routing）中的“标准费率”和“标准工时”。
- **卷积引擎**: 
    - `标准成本 = Σ(子件标准用量 * 子件标准单价) + (标准工时 * 标准费率)`。
- **模拟功能 (What-if Analysis)**: 开发者应设计“草稿成本”与“正式成本”。允许用户在不改变现有系统的情况下，模拟原材料上涨 5% 对成品成本的影响。

### PostgreSQL 实现建议
- **递归 CTE 卷积**: 
  ```sql
  WITH RECURSIVE std_cost_rollup AS (
    SELECT id, parent_id, std_price FROM item_master WHERE is_raw_material = true
    UNION ALL
    SELECT i.id, i.parent_id, SUM(child.std_price * b.usage_qty) 
    FROM item_master i 
    JOIN bom_struct b ON i.id = b.parent_id
    JOIN std_cost_rollup child ON b.child_id = child.id
    GROUP BY i.id, i.parent_id
  )
  ```
  利用递归 CTE 在数据库层直接完成多级成本卷积，大幅减少网络传输开销。
- **物化视图存储快照**: 将每个版本的标准成本存储在物化视图中，既能保证查询性能，又方便进行跨版本的成本对比分析。

---

## 2. 差异分析：三差异法 (Variance Analysis)

### 企业痛点
**“成本超标了，但不知道是买贵了还是用多了”**。如果开发者只给一个总额差异，管理层根本没法追责。

### 核心公式
开发者必须在代码中实现以下拆解逻辑：
1.  **材料价格差异 (PPV)**: `(实际单价 - 标准单价) * 实际采购数量`。
2.  **材料用量差异**: `(实际用量 - 标准用量) * 标准单价`。
3.  **人工/制造费率差异**: `(实际费率 - 标准费率) * 实际工时`。

### 开发逻辑点
- **差异埋点**: 差异不是月末算出来的，而是**在业务发生的瞬间**产生的。
    - *场景*: 采购入库单审核。
    - *逻辑*: 开发者需立即对比 `PO价格` 与 `料品标准价`，并产生一笔 `PPV (Purchase Price Variance)` 凭证存入差异表。

### PostgreSQL 实现建议
- **触发器实时计算差异**: 在采购入库单和领料单的 `AFTER INSERT` 触发器中嵌入差异计算逻辑。
  ```sql
  NEW.price_variance := (NEW.actual_price - i.std_price) * NEW.qty 
  FROM item_master i WHERE i.id = NEW.item_id;
  ```
  实现“业务发生即产生差异”，为管理层提供秒级的预警能力。
- **JSONB 记录差异上下文**: 将产生差异时的标准单价、实际单价、采购员等信息以 `JSONB` 格式存入差异记录，方便审计追溯。

---

## 3. 成本更新与版本控制

### 企业痛点
标准成本一年一定，但年中工艺改进了，怎么更新？

### 开发逻辑点
- **版本化管理**: 开发者需设计 `CostVersion` 表，记录不同年度、不同版本的标准成本。
- **库存重估 (Revaluation)**: 
    - **逻辑重难点**: 当用户更新“标准成本”时，开发者必须自动扫描当前仓库中的所有库存。
    - **计算**: `库存增值/贬值 = (新标准价 - 旧标准价) * 当前库存量`。
    - **财务抛送**: 必须同步生成一笔财务调整凭证，确保库存明细账与总账对齐。

### PostgreSQL 实现建议
- **时间范围类型 (DATERANGE)**: 为成本版本表增加 `valid_period` 字段，利用 `daterange` 确保不同版本之间的时间连续性且不重叠。
- **批量更新优化**: 
  ```sql
  UPDATE inventory_balance b
  SET std_cost = v.new_std_cost,
      revaluation_amount = (v.new_std_cost - b.std_cost) * b.on_hand_qty
  FROM cost_update_version v
  WHERE b.item_id = v.item_id AND v.status = 'Approved';
  ```
  利用 `UPDATE ... FROM` 语法一次性完成全量库存的重估计算，确保数据的一致性。
- **咨询锁 (Advisory Locks)**: 在执行库存重估事务期间，使用 `pg_advisory_xact_lock` 锁定重估过程，防止并发业务单据（如出库）导致的数据冲突。

---

## 4. 开发者 Checklist

- [ ] **低层码应用**: 标准成本卷积是否也遵循了“低层码”顺序，确保底层变动能自动传导至顶层？
- [ ] **异常处理**: 针对“BOM 中有物料但没设标准价”的情况，是否有预警提示？
- [ ] **多币种**: 卷积过程中，如果是进口件，是否使用了正确的“标准汇率”进行折算？
- [ ] **穿透报表**: 报表是否支持从“成品差异”一键点开，看到是哪个子件、哪道工序贡献的差异？
