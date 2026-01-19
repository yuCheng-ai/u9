# MRP/MPS 运算与平衡 - 开发者详尽指南

## 概述
MRP（物料需求计划）是 ERP 的“中央处理器”。在开发视角下，MRP 的本质是**基于时间轴的供需矢量对冲**。它的核心逻辑是在正确的时间，准备正确数量的正确物料。开发者必须利用 PostgreSQL 的**递归查询能力**、**窗口函数**和**高性能中间表**，构建一个能够处理海量 BOM 展开与供需平衡的计算引擎。

---

## 1. 核心算法：时序净需求计算 (Net Requirement)

### 业务场景
“算多了是库存，算少了是停工”。净需求必须考虑现有库存、在途供应、已分配需求以及安全库存。

### 开发规范
- **供需对冲逻辑**: `净需求 = (毛需求 + 安全库存) - (现有库存 + 预计入库 - 预计出库)`。
- **时间归并**: 需求应按天或周归并，并根据物料提前期（Lead Time）向前偏移。
- **技术实现建议**: 
    - **滚动可用量计算**: 利用 PostgreSQL 的 **Window Functions (窗口函数)**，通过 `SUM(qty) OVER (PARTITION BY item_id ORDER BY plan_date)` 实时计算全时间轴的预计可用量（PAB）。
    - **逾期处理**: 在 SQL 过滤中增加逻辑，自动将逾期未收货的 PO 或逾期未完工的 MO 标识为“风险供应”，并由 MRP 建议重新排程。
    - **示例代码**:
      ```sql
      -- 计算物料 PAB (Projected Available Balance)
      SELECT 
          item_id, plan_date, change_qty,
          SUM(change_qty) OVER (PARTITION BY item_id ORDER BY plan_date) as pab
      FROM mrp_supply_demand_details;
      ```

---

## 2. 产能约束与排产方案 (CRP & Simulation)

### 业务场景
- **无限产能 (Infinite Capacity)**: 只考虑物料，假设产能无限。适合计划初期。
- **有限产能 (Finite Capacity/CRP)**: 必须考虑工作中心（WC）的实际工时约束。
- **逾期供应处理**: 逾期未收货的采购单（PO）或未完工的生产单（MO），系统是假设明天就能到货，还是自动向后推延？

### 开发规范
- **方案隔离**: 所有计算结果必须关联 `Plan_ID`。
- **逾期自动推延**: 针对逾期单据，MRP 引擎应提供“重排建议”（Reschedule Message），而非盲目假设供应依然有效。

### 技术实现建议
- **资源负荷计算**: 将工作中心的日历与可用工时存储为位图（Bitmap）或 `JSONB` 数组，快速进行“扣减”操作。
- **高性能中间存储**: 使用 PostgreSQL 的 **UNLOGGED TABLES** 存储 MRP 计算的中间过程数据。
- **示例代码**:
  ```sql
  -- 检查资源是否超载
  SELECT wc_id, date, sum(required_hours) as load
  FROM mrp_resource_plan
  GROUP BY wc_id, date
  HAVING sum(required_hours) > :max_capacity;
  ```

---

## 3. BOM 展开与低层码逻辑 (LLC & Explosion)

### 业务场景
MRP 必须从最高层父件向最底层子件逐层计算，否则会导致物料需求计算不全。

### 开发规范
- **LLC (低层码) 优先**: 必须按照 LLC 从小到大的顺序处理物料。
- **批量舍入**: 考虑起订量（MOQ）和包装增量（Lot Size）。
- **技术实现建议**: 
    - **递归 LLC 计算**: 利用 PostgreSQL 的 **Recursive CTE (递归公用表表达式)** 自动计算全库物料的 LLC 码，相比于传统的循环逻辑，效率提升数十倍。
    - **舍入逻辑封装**: 编写 PL/pgSQL 函数处理复杂的舍入规则（如：`CEIL(qty / lot_size) * lot_size`），确保计算逻辑在数据库层统一。
    - **示例代码**:
      ```sql
      -- 递归计算低层码 (LLC)
      WITH RECURSIVE llc_calc AS (
          SELECT id as item_id, 0 as level FROM item WHERE is_top_level = true
          UNION ALL
          SELECT b.component_id, lc.level + 1
          FROM bom b JOIN llc_calc lc ON b.item_id = lc.item_id
      )
      SELECT item_id, MAX(level) as llc FROM llc_calc GROUP BY item_id;
      ```

---

## 4. 计划输出与例外消息 (Action Messages)

### 业务场景
MRP 不仅产生建议单，更重要的是产生“例外消息”（如：取消、提前、推迟）。

### 开发规范
- **例外识别**: 自动对比现有供应日期与需求日期的偏差。
- **建议转正式**: 提供一键将建议单（Planned Order）转化为正式采购单或生产单的接口。
- **技术实现建议**: 
    - **差异分析引擎**: 利用 PostgreSQL 的 **EXCEPT** 或 **INTERSECT** 操作符快速比对本次计算与上次计算的差异，仅向用户推送增量变动消息。
    - **批量转化**: 使用 `INSERT INTO ... SELECT` 结构实现建议单到正式单的批量转化，确保数据一致性。

---

## 5. 开发者 Checklist

- [ ] **递归深度**: 递归 CTE 是否设置了合理的深度限制，防止 BOM 环路导致死循环？
- [ ] **工厂日历**: 日期偏移计算是否通过数据库函数关联了 `Work_Calendar`，排除了非工作日？
- [ ] **高精度**: 所有的需求数量计算是否使用了 `numeric(24, 12)` 以防止多层 BOM 累加产生的精度丢失？
- [ ] **并行计算**: 是否利用了 PostgreSQL 的 **Parallel Query (并行查询)** 特性来加速大规模供需对冲的扫描速度？
- [ ] **事务隔离**: MRP 运行期间是否使用了 `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` 确保快照的一致性？
