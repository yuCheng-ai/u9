# 销售执行 (Sales Process) - 开发者详尽指南

## 概述
销售执行是企业的“现金流入口”。在 ERP 开发中，销售订单（SO）是整个系统的**第一动力源**。它不仅是一张单据，其产生的数据涟漪会扩散到生产（MO）、采购（PO）和物流（Logistics）。开发者必须利用 PostgreSQL 的**高并发控制**和**复杂查询能力**，确保销售链条的严密性。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **变更失控**：客户频繁改单，找不到最初的承诺交期和价格。 | **全量版本快照**：禁止原地修改已核准单据，变更即升版（V1->V2），并使用 `JSONB` 固化历史。 |
| **库存抢夺**：热门商品被多个销售员同时下单，导致“超卖”。 | **原子化库存锁定**：利用 `SELECT ... FOR UPDATE` 结合 `SKIP LOCKED` 实现高性能、无冲突的库存抢占。 |
| **退货套利**：客户按高价退货，但原单其实是打折买的。 | **原单强制溯源**：RMA（退货）必须强关联原 SO 行，系统自动锁定单价，防止人为篡改。 |
| **回款风险**：大客户信用已击穿，销售员却依然能录单出货。 | **事务级信用拦截**：在 SO 审核事务中嵌入信用检查函数，确保“校验-锁定-扣减”原子化。 |

---

## 1. 销售订单的需求驱动与版本化 (Demand & Revision)

### 业务场景
客户今天改数量，明天改交期。系统必须记录每一次变更。

### 开发逻辑：版本演进 (Revision)
1. **禁止原地修改**: 已核准的 SO 只能通过“变更”按钮修改。
2. **快照归档**: 变更前，系统自动将当前版本存入 `sales_order_history`。
3. **版本自增**: 主表 `version` 字段递增。

### 技术实现建议
- **快照存档**: 利用 PostgreSQL 的 `to_jsonb(sales_order.*)` 快速生成快照。
- **示例代码**:
  ```sql
  -- 变更保存时的原子操作
  BEGIN;
  INSERT INTO sales_order_history (so_id, version, snapshot) 
  SELECT id, version, to_jsonb(sales_order.*) FROM sales_order WHERE id = :id;
  
  UPDATE sales_order SET version = version + 1, status = 'Draft' WHERE id = :id;
  COMMIT;
  ```

---

## 2. 智能出货与库存锁定 (Shipping & Allocation)

### 业务场景
在高并发销售环境下，必须防止多个销售员抢夺同一批库存。

### 开发规范
- **硬预留 (Hard Allocation)**: 订单核准时，必须锁定相应货位的库存，将其状态标记为 `Reserved`。
- **拼单策略**: 同一送货地址的多个 SO 行应自动聚合生成一张出货申请单。

### 技术实现建议
- **并发锁定**: 使用 `FOR UPDATE SKIP LOCKED`。
- **示例代码**:
  ```sql
  -- 抢占式库存预留
  WITH target_bins AS (
      SELECT id FROM inv_bin_stock 
      WHERE item_id = :item_id AND available_qty >= :needed_qty
      FOR UPDATE SKIP LOCKED
      LIMIT 1
  )
  UPDATE inv_bin_stock SET reserved_qty = reserved_qty + :needed_qty 
  WHERE id = (SELECT id FROM target_bins);
  ```

---

## 3. RMA 退货闭环与原单追溯 (Return Management)

### 业务场景
退货不能只是简单的库存增加，必须严格追溯原单价格。

### 开发规范
- **原单强关联**: RMA 必须强制引用原销售订单 ID 和行 ID。
- **价格锁定**: 系统自动带出原单成交价，并在 UI 上置灰（Read-only）。

### 技术实现建议
- **LATERAL JOIN 溯源**: 实时查询该客户历史订单中该料品的最近成交价。
- **示例代码**:
  ```sql
  -- RMA 录入时自动匹配原单
  SELECT so.order_no, sol.price, sol.qty_shipped
  FROM sales_order_line sol
  JOIN sales_order so ON sol.so_id = so.id
  WHERE sol.item_id = :item_id AND so.customer_id = :cust_id
  ORDER BY so.approved_time DESC LIMIT 5;
  ```

---

## 4. 信用控制与拦截 (Credit Control)

### 业务场景
信用控制是销售的最后一道防线。

### 开发逻辑
- **实时拦截**: 信用计算逻辑应在数据库存储过程中封装。
- **拦截点**: `保存`时仅提示（Warning），`提交/审核`时强拦截（Error）。

---

## 5. 开发者 Checklist

- [ ] **事务隔离**: 库存锁定是否使用了 `FOR UPDATE`？在高并发场景下是否测试过死锁风险？
- [ ] **高精度**: 所有的折扣计算、税金计算是否使用了 `numeric` 类型？
- [ ] **幂等性**: 对接电商平台的订单接口是否使用了外部订单号（ExtOrderNo）配合唯一约束？
- [ ] **性能**: 复杂的销售看板是否利用了 PostgreSQL 的 **物料化视图 (Materialized Views)**？
- [ ] **扩展性**: 销售订单的自定义扩展属性是否使用了 `JSONB` 存储？
- [ ] **反审核拦截**: 销售订单若已生成出货单或发票，是否在后端代码级禁止了弃审操作？
