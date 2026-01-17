# 销售执行 (Sales Process) - 开发者详尽指南

## 概述
销售执行是企业的“现金流入口”。在 ERP 开发中，销售订单（SO）是整个系统的**第一动力源**。它不仅是一张单据，其产生的数据涟漪会通过数据库事务和异步通知，扩散到生产（MO）、采购（PO）和物流（Logistics）。开发者必须利用 PostgreSQL 的**高并发控制**和**复杂查询能力**，确保销售链条的严密性。

---

## 1. 销售订单的需求驱动 (Demand Drive)

### 业务场景
“销售下个单，全厂跑断腿”。SO 核准后，必须确保需求信息能实时、准确地传递给 MRP 引擎。

### 开发规范
- **需求池捕获**: SO 保存并核准后，相关记录应进入需求池。
- **ATO (Assemble-to-Order) 模式**: 对于定制化产品，核准时应自动根据配置参数生成临时 BOM。
- **技术实现建议**: 
    - **变更通知**: 利用 PostgreSQL 的 **Logical Decoding (逻辑解码)** 实时监听 SO 表的变更，将需求异动异步推送给 MRP 服务。
    - **动态配置**: 使用 `JSONB` 存储 SO 行的个性化选配参数，利用 `jsonb_to_record` 快速解析并参与 BOM 自动展开。
    - **示例代码**:
      ```sql
      -- 解析 SO 行中的 JSONB 选配参数
      SELECT * FROM jsonb_to_record(:config_json) AS x(color text, size text, material text);
      ```

---

## 2. 智能出货与库存锁定 (Shipping & Allocation)

### 业务场景
在高并发销售环境下，必须防止多个销售员抢夺同一批库存导致的“超卖”或“分配不均”。

### 开发规范
- **硬预留逻辑 (Hard Allocation)**: 出货申请核准时，必须锁定相应货位的库存。
- **拼单策略**: 同一送货地址、同一承运商的多个 SO 行应自动聚合，以降低物流成本。
- **技术实现建议**: 
    - **并发锁定**: 使用 `SELECT ... FOR UPDATE SKIP LOCKED` 进行库存分配，确保高并发下单时不产生死锁，且能快速跳过已被锁定的货位。
    - **性能优化**: 对库存表建立 **Partial Indexes (部分索引)**（例如：`WHERE qty > locked_qty`），大幅提升可用库存的检索速度。
    - **示例代码**:
      ```sql
      -- 高并发库存抢占逻辑
      WITH target_stock AS (
          SELECT id FROM inv_onhand 
          WHERE item_id = :item_id AND qty > 0
          FOR UPDATE SKIP LOCKED
          LIMIT 1
      )
      UPDATE inv_onhand SET qty = qty - :order_qty FROM target_stock WHERE inv_onhand.id = target_stock.id;
      ```

---

## 3. RMA 退货闭环与原单追溯 (Return Management)

### 业务场景
退货不能只是简单的库存增加，必须严格追溯原单价格，防止财务风险。

### 开发规范
- **原单强关联**: RMA（退货授权）必须强制引用原销售订单。
- **价格追溯**: 系统自动带出原单成交价，禁止随意修改。
- **技术实现建议**: 
    - **复杂关联查询**: 利用 PostgreSQL 的 **LATERAL JOIN**，在 RMA 录入时实时查询该客户历史订单中该料品的加权平均价或最近成交价，作为审计参考。
    - **高精度计算**: 所有单价、金额字段必须使用 `numeric(24, 12)`，确保在多次打折、退货计算后不产生精度误差。
    - **示例代码**:
      ```sql
      -- 使用 LATERAL JOIN 追溯最近成交价
      SELECT so.order_no, so_line.price
      FROM rma_line rl
      CROSS JOIN LATERAL (
          SELECT order_no, price FROM sales_order_line 
          WHERE item_id = rl.item_id AND customer_id = :customer_id
          ORDER BY create_time DESC LIMIT 1
      ) so_line;
      ```

---

## 4. 信用控制与拦截 (Credit Control)

### 业务场景
信用控制是销售的最后一道防线。必须确保在出货环节执行强有力的拦截。

### 开发规范
- **实时拦截**: 信用超限时，单据必须进入“挂起”状态。
- **算法一致性**: 信用计算逻辑应在数据库层封装，确保所有入口调用一致。
- **技术实现建议**: 
    - **原子操作**: 将信用额度检查与单据审核逻辑封装在同一个 **PostgreSQL 函数 (PL/pgSQL)** 中。利用数据库的事务原子性，确保“信用校验”与“状态变更”之间无时间差。
    - **分布式安全**: 若系统为分布式部署，建议利用数据库的 **Advisory Locks (建议锁)** 实现跨节点的销售信用互斥锁。

---

## 5. 开发者 Checklist

- [ ] **事务隔离**: 库存锁定是否使用了 `FOR UPDATE`？在高并发场景下是否测试过死锁风险？
- [ ] **高精度**: 所有的折扣计算、税金计算是否使用了 `numeric` 类型？
- [ ] **幂等性**: 对接电商平台的订单接口是否使用了 `External_Order_ID` 配合唯一约束（Unique Constraint）？
- [ ] **性能**: 复杂的销售报表（如多维销售毛利分析）是否利用了 PostgreSQL 的 **Materialized Views (物料化视图)** 进行预计算？
- [ ] **扩展性**: 销售订单的自定义扩展属性是否使用了 `JSONB` 存储，并配置了 GIN 索引？
