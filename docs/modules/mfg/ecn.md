# ECN 工程变更 (ECN) - 开发者详尽指南

## 概述
工程变更（ECN/ECR）是制造企业的“手术刀”。开发者必须意识到：ECN 不只是修改一张表，它是一系列**连锁反应的触发器**。如果逻辑不严密，会导致生产线领错料、库存呆滞或成品报废。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **变更“断层”**：BOM 改了，但正在生产的订单（MO）还在按老图纸领料。 | **WIP 自动刷新引擎 (WIP_Refresh)**：ECN 审核后，利用递归 CTE 扫描所有“未完工”的 MO，对比新旧 BOM 差异并强制更新备料明细。 |
| **版本冲突**：同一料品在短时间内发生多次变更，导致生效日期重叠。 | **DateRange 排他约束**：利用 PostgreSQL 的 `EXCLUDE` 约束，确保同一物料的变更周期在时间轴上绝对互斥。 |
| **追溯断链**：出了质量问题，查不到当时生产时到底用的是哪一个 ECN 版本。 | **单据结构固化 (Structure Snapshot)**：在 MO 生成时，将当时的 BOM 结构以 `JSONB` 格式物理固化到订单中，拒绝动态关联。 |
| **影响范围不明**：改一个螺丝，不知道哪些产成品用到了它。 | **递归向上反查 (Where-Used Analysis)**：实现极速的 BOM 向上递归，一键列出所有受影响的顶层物料及关联的在途采购单/生产单。 |

---

## 1. 变更范围与冲突检测 (Impact Analysis)

### 业务场景
**“改了一个螺丝，结果 100 个订单都要重算”**。开发者必须自动识别受影响的范围。

### 技术实现建议
- **递归向上反查**:
  ```sql
  -- 向上递归查找受影响的所有父项及顶层产成品
  WITH RECURSIVE impact_tree AS (
      -- 初始行：直接引用该组件的父项
      SELECT parent_item_id, 1 as level FROM bom WHERE component_id = :changed_item
      UNION ALL
      -- 递归行：父项的父项
      SELECT b.parent_item_id, it.level + 1 
      FROM bom b JOIN impact_tree it ON b.component_id = it.parent_item_id
  )
  SELECT DISTINCT parent_item_id FROM impact_tree;
  ```

---

## 2. 在制品 (WIP) 的刷新策略 (WIP Handling)

### 业务场景
变更发生时，生产线上还有 50 个半成品。系统必须自动对比 MO 现有备料（mo_item_list）与新 BOM 的差异。

### 开发规范
- **差异对比算法**: 使用 `EXCEPT` 运算符。
- **原子化更新**:
  ```sql
  -- 找出需要增加的物料（新 BOM 有，但 MO 备料没有）
  SELECT component_id, qty FROM v_new_bom 
  EXCEPT 
  SELECT item_id, qty FROM mo_item_list WHERE mo_id = :mo_id;
  
  -- 找出需要删除的物料（MO 备料有，但新 BOM 已删除）
  SELECT item_id FROM mo_item_list WHERE mo_id = :mo_id AND is_picked = false
  EXCEPT
  SELECT component_id FROM v_new_bom;
  ```

---

## 3. 版本断点与排他控制 (Concurrency & Exclusion)

### 业务场景
防止两个 ECN 同时修改同一个 BOM 导致数据错乱。

### 技术实现建议
- **排他约束**:
  ```sql
  -- 确保同一 Item 的 ECN 生效时间不重叠
  ALTER TABLE ecn_header ADD EXCLUDE USING gist (
    item_id WITH =,
    valid_period WITH &&
  );
  ```
- **建议锁**: 在执行 BOM 物理更新（从 ECN 写入 BOM 表）时，必须使用 `pg_advisory_xact_lock(item_id)`。

---

## 4. 严谨性校验：变更闭环 (Closing the Loop)

### 业务场景
ECN 审核通过了，但旧料的采购单还没取消，仓库还在发旧料。

### 开发逻辑点
- **联动操作**: ECN 审核事务内必须包含：
  1. **BOM 升版**: 物理更新 `bom` 表。
  2. **呆滞预警**: 将被替换的旧料（Old_Part）标记为 `obsolete_status = 'Pending_Clearance'`。
  3. **任务下发**: 向采购模块发送“旧料 PO 取消建议”，向仓库发送“旧料封存任务”。

---

## 5. 开发者 Checklist

- [ ] **递归性能**: 大规模 BOM（万级以上）的反查性能是否通过复合索引 `(component_id, parent_item_id)` 优化？
- [ ] **时间重叠**: 是否通过 `EXCLUDE` 约束防止了同一物料的 ECN 生效日期重叠？
- [ ] **MO 联动**: ECN 审核后，是否触发了“受影响 MO 备料自动刷新”逻辑？
- [ ] **版本快照**: MO 生产时，是否将 BOM 结构固化到了 `mo_bom_snapshot` (JSONB) 字段中？
- [ ] **物料呆滞**: 变更导致不再使用的旧料，是否自动触发了呆滞库存分析？
- [ ] **反审核拦截**: 如果 ECN 已被某个 MO 执行了刷新，是否在后端禁止了 ECN 的弃审？
