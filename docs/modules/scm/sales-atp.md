# 可用量检查与交付承诺 (Sales ATP) - 开发者详尽指南

## 概述
对于销售来说，ATP（Available To Promise）是**“信任的基石”**。在 ERP 开发中，销售 ATP 不仅仅是查询库存，它是对**未来产能、在途物资以及多订单抢占逻辑**的实时模拟。开发者必须利用 PostgreSQL 的**时序处理能力**、**窗口函数**和**并发控制**，构建一个高性能、高准确性的交付承诺引擎。

---

## 1. 实时 ATP 校验与软预留 (Real-time Check)

### 业务场景
“录单即承诺”。销售员在录入 SO 行时，系统必须在毫秒级告知该日期是否有货。

### 开发规范
- **插入式检查**: 在单据行失去焦点时，自动触发 ATP 计算。
- **模拟锁座 (Soft Reservation)**: 在订单未最终保存前，临时锁定 ATP 额度 5-10 分钟。
- **技术实现建议**: 
    - **时间维度计算**: 使用 PostgreSQL 的 **Window Functions (窗口函数)**。通过 `SUM(change_qty) OVER (ORDER BY plan_date)` 实时计算每个时间点的滚动可用量。
    - **并发锁座**: 利用 `SELECT ... FOR UPDATE SKIP LOCKED` 锁定特定批次的“虚拟额度”，确保多个销售员同时下单时不产生超卖，且能快速跳过已锁定的额度。
    - **示例代码**:
      ```sql
      -- 计算滚动可用量 (PAB)
      SELECT 
          plan_date,
          change_qty,
          SUM(change_qty) OVER (ORDER BY plan_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as running_atp
      FROM atp_supply_demand_view
      WHERE item_id = :item_id;
      ```

---

## 2. 需求优先级与资源抢占 (Priority & Allocation)

### 业务场景
当库存不足时，优先保障 Grade A 级客户，甚至需要“强制夺取”已分配给低优先级订单的额度。

### 开发规范
- **优先级模型**: 引入 `Customer_Rank` 和 `Order_Priority` 权重。
- **自动/手动重排**: 支持定期自动重排（Rescheduling）或管理员手动调整分配。
- **技术实现建议**: 
    - **分配算法**: 使用 **CTE (公用表表达式)** 构建多级分配逻辑。第一层分配 A 类需求，第二层分配剩余资源给 B 类，依此类推。
    - **范围查询优化**: 利用 `daterange` 存储供应/需求窗口，通过 `&&` 操作符快速判定需求日期是否落在供应覆盖范围内。
    - **示例代码**:
      ```sql
      -- 使用 daterange 判定有效期
      SELECT * FROM sales_price_list 
      WHERE item_id = :item_id 
        AND validity_period && daterange(current_date, current_date + 1);
      ```

---

## 3. CTP：基于能力的承诺 (Capable To Promise)

### 业务场景
“仓库没货，但工厂现在赶工能不能在 3 天内交货？”。这需要穿透库存，直接计算生产能力。

### 开发规范
- **CTP 穿透**: ATP 失败时，自动触发虚拟 BOM 展开与产能负荷检查。
- **异步响应**: 这是一个重量级计算，应通过消息或长连接通知结果。
- **技术实现建议**: 
    - **递归 BOM 展开**: 利用 PostgreSQL 的 **Recursive CTE** 进行多层 BOM 实时展开，检查关键原材料的供应（PO ATP）。
    - **产能模拟**: 将工作中心（Work Center）的负荷数据存储为 `JSONB` 数组，利用数据库的并行查询能力快速寻找可插入的“生产空档”。
    - **示例代码**:
      ```sql
      -- 递归展开 BOM 检查物料供应
      WITH RECURSIVE bom_tree AS (
          SELECT item_id, component_id, qty FROM bom WHERE item_id = :root_item
          UNION ALL
          SELECT b.item_id, b.component_id, b.qty 
          FROM bom b INNER JOIN bom_tree bt ON b.item_id = bt.component_id
      )
      SELECT bt.component_id, atp.qty FROM bom_tree bt 
      JOIN inv_atp_view atp ON bt.component_id = atp.item_id;
      ```

---

## 4. 影响分析与“What-if”模拟 (Impact Analysis)

### 业务场景
“大客户订单提前，我想知道这会挤掉哪些小客户的货”。

### 开发规范
- **模拟沙箱**: 在不改变生产数据库的情况下，模拟资源重分配的结果。
- **自动通知机制**: 受影响的订单应自动标识“延期风险”，并通知销售员。
- **技术实现建议**: 
    - **物料化视图 (Materialized View)**: 对于非实时的 ATP 预览，使用物料化视图预计算每日汇总数据，通过 `REFRESH MATERIALIZED VIEW CONCURRENTLY` 保证查询性能。
    - **差异比对**: 使用 `JSONB` 存储模拟前后的分配快照，通过 `jsonb_each` 对比发现受影响的订单 ID 列表。

---

## 5. 开发者 Checklist

- [ ] **性能**: ATP 计算是否避免了在循环中进行 SQL 查询？是否利用了窗口函数进行单次扫描？
- [ ] **换算精度**: 销售单位与基本单位的换算是否使用了 `numeric`，并考虑了“最后一行补差”逻辑？
- [ ] **清理逻辑**: 软预留（锁座）的过期自动清理机制是否已通过数据库 **Cron 任务** 或消息队列实现？
- [ ] **时区处理**: 跨国组织的交货期计算是否统一使用了 `timestamptz`？
- [ ] **索引优化**: 供应需求表是否针对 `item_id` 和 `plan_date` 建立了复合索引？
