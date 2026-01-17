# BOM 维护与多版本控制 (BOM) - 开发者详尽指南

## 概述
物料清单（BOM）是制造系统的“基因”。在开发视角下，BOM 不是一张静态表，而是一个**具有时间维度的递归图结构**。开发者必须利用 PostgreSQL 的**递归查询能力**、**范围类型约束**和**图路径分析**，确保 BOM 结构的高效检索与逻辑严密性。

---

## 1. 递归存储与环路检测 (Structure & Cycle)

### 业务场景
一个复杂产品（如大型机械）可能有上万个零件，层级极深。开发者必须解决高效展开与防止死循环引用的问题。

### 开发规范
- **递归展开**: 必须支持全阶、单阶、反查（Where-used）三种模式。
- **环路检查**: 保存 BOM 时，必须检测是否存在 A -> B -> A 的循环引用。
- **技术实现建议**: 
    - **递归 CTE**: 使用 PostgreSQL 的 `WITH RECURSIVE` 语法进行全阶展开。对于超大规模树，建议结合 **LTREE 扩展** 存储路径枚举，实现 O(1) 级别的层级检索。
    - **循环探测**: 利用 PostgreSQL 14+ 的 `CYCLE` 子句自动探测递归中的环路，并在数据库层抛出异常，防止应用层死锁。
    - **示例代码**:
      ```sql
      -- 使用递归 CTE 进行全阶 BOM 展开，并检测环路
      WITH RECURSIVE bom_tree AS (
          SELECT item_id, component_id, 1 as level
          FROM bom WHERE item_id = :root_item
          UNION ALL
          SELECT b.item_id, b.component_id, bt.level + 1
          FROM bom b 
          JOIN bom_tree bt ON b.item_id = bt.component_id
      ) 
      CYCLE component_id SET is_cycle USING path
      SELECT * FROM bom_tree WHERE NOT is_cycle;
      ```

---

## 2. 版本切换与时间轴控制 (Effectivity)

### 业务场景
“新旧更替”。BOM 的变更必须精确到天，且要处理好“用完即换”的平滑过渡。

### 开发规范
- **日期过滤**: 所有的 BOM 接口必须包含 `EffectDate`。
- **防重叠校验**: 同一个父件在同一时间内，只能有一个生效的版本。
- **技术实现建议**: 
    - **范围类型**: 使用 `daterange` 存储 BOM 组件的有效期。
    - **排除约束**: 利用 PostgreSQL 的 **EXCLUDE CONSTRAINT** 配合 `gist` 索引，强制保证同一个父件下的子件版本在时间线上不重叠，从数据库底层杜绝逻辑冲突。
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
- **技术实现建议**: 
    - **动态展开**: 在递归 CTE 中增加 `SupplyType` 判断，逻辑上跳过虚设件层级，直接连接其下层子件。
    - **规则存储**: 使用 `JSONB` 存储替代料的复杂策略（如：部分替代、整组替代），并利用 `jsonb_to_recordset` 在 SQL 中直接参与库存预分配计算。
    - **示例代码**:
      ```sql
      -- 处理替代料优先级
      SELECT * FROM jsonb_to_recordset(:sub_rules) AS x(alt_item_id int, priority int, ratio numeric);
      ```

---

## 4. 损耗率与精密用量计算 (Usage & Precision)

### 业务场景
精密制造要求用量计算极其准确，必须考虑固定损耗与变动损耗。

### 开发规范
- **计算公式**: `实际需求 = (标准用量 / 基数) * (1 + 损耗率) + 固定损耗`。
- **精度控制**: 必须统一计算精度。
- **技术实现建议**: 
    - **高精度字段**: 所有的用量、损耗率字段统一使用 `numeric(24, 12)`。
    - **预计算视图**: 建立物料化视图（Materialized View）预先卷积全阶标准用量，减少 MRP 运行时的大规模重复计算。

---

## 5. 开发者 Checklist

- [ ] **递归深度**: 递归查询是否设置了 `depth` 限制以应对极端情况？
- [ ] **低层码 (LLC)**: 是否实现了基于递归 CTE 的 LLC 自动更新算法？
- [ ] **约束严密性**: 是否在数据库层通过 `CHECK` 约束防止了用量为负数的情况？
- [ ] **性能优化**: 针对常用的 BOM 反查（Where-used）场景，是否对子件 ID 建立了高效索引？
- [ ] **版本历史**: BOM 的每一次 `Publish` 是否都保留了 `JSONB` 格式的快照以备审计？
