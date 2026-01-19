# BOM 维护与多版本控制 (BOM) - 开发者详尽指南

## 概述
物料清单（BOM）是制造系统的“基因”。在开发视角下，BOM 不是一张静态表，而是一个**具有时间维度的递归图结构**。开发者必须利用 PostgreSQL 的**递归查询能力**、**范围类型约束**和**图路径分析**，确保 BOM 结构的高效检索与逻辑严密性。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **BOM 环路噩梦**：用户不小心把成品设成了零件，导致系统陷入死循环崩溃。 | **实时递归环路探测**：在 `BeforeSave` 事务中，利用向上递归 CTE 探测血缘，发现循环引用立即拦截。 |
| **版本“重叠”**：同一个料品在同一天有两个不同的有效 BOM，MRP 算不准。 | **排他性时间约束（EXCLUDE）**：利用数据库 GIST 索引，强制保证同一物料的有效期区间在时间轴上不重叠。 |
| **虚设件穿透难**：研发为了方便看图纸加了虚设件，但生产领料得直接领底层的螺丝。 | **逻辑展开引擎**：在展开算法中识别 `Phantom` 标识，自动实现“穿透”逻辑，直接连接子项。 |
| **替代料分配乱**：主料没货了，替代料怎么领？谁先谁后？ | **优先级路由模型**：定义替代组（Substitution Group）与优先级，结合 `JSONB` 规则引擎自动匹配库存。 |

---

## 1. 递归存储与高性能环路检测 (Structure & Performance)

### 业务场景
一个复杂产品可能有上万个零件，层级极深。开发者必须解决高效展开与**保存时实时环路检测**的问题。

### 技术实现建议
- **高效向上探测**: 只需对本次修改的 `parent_id` 向上递归探测其所有父件，看是否包含本次要加入的 `component_id`。
- **示例代码**:
  ```sql
  -- 高效向上探测环路
  WITH RECURSIVE parent_trace AS (
      SELECT parent_item_id FROM bom WHERE component_id = :new_parent_id
      UNION ALL
      SELECT b.parent_item_id FROM bom b JOIN parent_trace pt ON b.component_id = pt.parent_item_id
  )
  SELECT 1 FROM parent_trace WHERE parent_item_id = :new_component_id LIMIT 1;
  ```

---

## 2. 版本切换与时间轴控制 (Effectivity)

### 业务场景
“新旧更替”。BOM 的变更必须精确到天。

### 技术实现建议
- **排除约束**: 利用 PostgreSQL 的 **EXCLUDE CONSTRAINT**。
- **示例代码**:
  ```sql
  -- 在数据库层强制版本时间不重叠
  ALTER TABLE bom_version ADD CONSTRAINT bom_time_no_overlap 
  EXCLUDE USING gist (parent_item_id WITH =, validity_period WITH &&);
  ```

---

## 3. 虚设件与替代料逻辑 (Phantom & Substitution)

### 业务场景
虚设件（Phantom）需穿透处理，替代料（Substitution）需按优先级自动分配。

### 开发规范
- **穿透展开**: 在生产领料计算时，遇到虚设件必须自动向下穿透到非虚设子件。
- **替代规则**: 替代组内必须定义优先级（Priority）与比例。

---

## 4. 损耗率与精密用量计算 (Usage & Precision)

### 业务场景
精密制造要求用量计算极其准确。

### 开发规范
- **计算公式**: `实际需求 = (标准用量 / 基数) * (1 + 损耗率) + 固定损耗`。
- **精度控制**: 所有的用量、损耗率字段统一使用 `numeric(24, 12)`。

---

## 5. 开发者 Checklist

- [ ] **递归深度**: 递归查询是否设置了 `depth` 限制以应对极端情况？
- [ ] **低层码 (LLC)**: 是否实现了基于递归 CTE 的 LLC 自动更新算法？（LLC 决定了 MRP 的计算顺序）。
- [ ] **约束严密性**: 是否在数据库层通过 `CHECK` 约束防止了用量为负数的情况？
- [ ] **性能优化**: 是否对 `parent_item_id` 和 `component_id` 建立了复合索引？
- [ ] **状态控制**: 已审核的 BOM 是否锁定了明细行，禁止直接修改（必须走 ECN）？
- [ ] **子项唯一性**: 同一个 BOM 版本下，同一个子项（Component）是否只允许出现一次？
