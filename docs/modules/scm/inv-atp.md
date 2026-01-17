# 动态预留与可用量 (ATP/PAB) - 开发者详尽指南

## 概述
库存不是一个简单的数字，而是一条**随时间波动的曲线**。开发者必须理解：ATP（Available To Promise）和 PAB（Projected Available Balance）是 ERP 的“时空引擎”。它回答的核心问题是：**“在未来某个时刻，我到底有多少货可以卖？”**

---

## 1. 核心算法：PAB 滚动计算 (PAB Calculation)

### 企业痛点
**“明明现在仓库里有 100 个，但系统却告诉我不能卖，因为明天这 100 个就要发给老客户”**。

### 开发逻辑点
- **供需流水模型**: 
    - 开发者需构建一个基于时间轴的 `Supply_Demand_Timeline`。
    - **PG 实现建议**: 利用 PostgreSQL 的**窗口函数 (Window Functions)** 实现滚动 PAB 计算，避免在内存中循环处理。
    ```sql
    -- 滚动计算 PAB 示例
    SELECT 
        expected_date,
        SUM(change_qty) OVER (PARTITION BY item_id ORDER BY expected_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as pab
    FROM supply_demand_view;
    ```
    - **PAB 公式**: `PAB[T] = PAB[T-1] + 预计入库[T] - 预计出库[T]`。
    - **开发注意**: 所有的入库（PO, MO, ASN）和出库（SO, MO_Issue, Transfer）单据都必须带有 `Expected_Date` 索引。
- **负库存预警**: 
    - 开发者需在计算过程中实时监控 `IF (PAB[T] < 0) THEN 产生缺料信号`。
    - **PG 实现建议**: 使用 `CHECK` 约束或 `EXCLUDE` 约束在数据库层级防止非法库存状态。

---

## 2. 动态预留逻辑 (Reservation Logic)

### 企业痛点
“大客户的货还没发，被仓库管理员偷偷先发给小客户了”。

### 开发逻辑点
- **双层预留模型**: 
    - **硬预留 (Hard Reservation)**: 绑定 `Lot_ID` 或 `Location_ID`。
    - **PG 实现建议**: 利用 PostgreSQL 的 **行级锁 (Row-level Locks)** 和 `FOR UPDATE SKIP LOCKED` 处理高并发预留请求。
    ```sql
    -- 锁定特定批次进行硬预留
    SELECT * FROM inventory_lot 
    WHERE item_id = ? AND qty >= ? 
    FOR UPDATE SKIP LOCKED 
    LIMIT 1;
    ```
    - **软预留 (Soft Reservation)**: 仅在 ATP 数量上扣减，不锁定实物。
- **预留自动释放 (TTL Mechanism)**: 
    - 开发者需实现一个后台 Job，自动清理“逾期未领料”的预留。
    - **PG 实现建议**: 可以结合 `LISTEN/NOTIFY` 或 `pg_cron` 触发超时释放逻辑。

---

## 3. ATP（可承诺量）查询逻辑

### 企业痛点
**“销售员在外面谈合同，想知道下周三能不能交货 500 台”**。

### 开发算法
- **ATP 逻辑点**: 
    - `ATP = 现有量 + 预计入库 - 预计出库（直到下一个预计入库发生前）`。
    - **PG 实现建议**: 使用 **物化视图 (Materialized Views)** 定期刷新复杂的 ATP 汇总数据，提升前端查询响应速度。
- **跨组织可见性**: 
    - 开发者需支持分布式查询。
    - **PG 实现建议**: 使用 `postgres_fdw` (Foreign Data Wrapper) 实现跨库/跨实例的实时库存可见性。

---

## 4. 并发控制与性能优化 (Performance)

### 企业痛点
“双 11 促销，100 个人同时抢 10 个库存，系统崩了，还超卖了”。

### 开发逻辑点
- **库存行锁 (Row-level Locking)**: 
    - 在执行预留时，必须使用 `SELECT FOR UPDATE` 锁定库存记录。
- **多租户隔离 (Data Isolation)**:
    - **PG 实现建议**: 启用 **行级安全 (RLS)** 确保各租户/组织的库存数据物理隔离。
    ```sql
    CREATE POLICY tenant_isolation ON inventory_balance
    USING (tenant_id = current_setting('app.current_tenant'));
    ```
- **高频更新优化**: 
    - **PG 实现建议**: 对于热点 Item，考虑使用 `UNLOGGED TABLE` 记录临时 ATP 变动，减少 WAL 日志开销（需权衡数据安全性）。

---

## 5. 开发者 Checklist

- [ ] **时间精度**: PAB 计算是按天还是按小时？（推荐按天，支持按小时微调）。
- [ ] **损耗系数**: 预计入库的 MO 数量是否考虑了产出率（Yield Rate）的衰减？
- [ ] **逾期处理**: 昨天应该到货但没到的 PO，在今天的 PAB 计算中是算作“即时供给”还是“无效供给”？
- [ ] **逆向事务**: 销售订单退货时，是否自动恢复了该 Item 的 ATP 额度？
