# 组织间协同 (Collaboration) - 开发者详尽指南

## 概述
组织间协同是 U9 的“皇冠上的明珠”。开发者必须理解：协同不是简单的单据拷贝，而是**跨法人实体的分布式业务事务**。每一个协同动作都涉及两个或多个组织的账簿同步、实物移动以及内部结算。

---

## 1. 内部购销协同：自动对账的基石 (Internal Buy/Sell)

### 企业痛点
**“总公司卖货，工厂发货，两边财务月底对账发现差了 100 万，查了半个月才发现是汇率和单价录入不一致”**。

### 开发逻辑点
- **单据镜像生成 (Mirroring)**: 
    - 开发者需实现 `Auto_Document_Bridge`。
    - **逻辑**: 当 A 组织核准 `Internal_Purchase_Order` 时，触发插件在 B 组织自动生成 `Internal_Sales_Order`。
    - **关键键值**: 必须在两张单据上保存 `Source_Document_GUID`，作为后续所有关联查询的唯一索引。
- **状态强一致性**: 
    - 开发者需确保：B 组织 `Shipment` (发货) 后，系统通过 `Cross_Org_Service` 自动在 A 组织执行 `Receipt` (收货)。
- **技术实现建议**: 
    - 利用 PostgreSQL 的 **Logical Decoding** 或 **Trigger + NOTIFY** 机制。当 A 组织单据核准时，数据库触发器发送通知，异步服务监听通知并执行跨组织抛单。
    - **示例代码**:
      ```sql
      -- 使用 NOTIFY 触发异步协同任务
      CREATE OR REPLACE FUNCTION notify_collab_bridge() RETURNS trigger AS $$
      BEGIN
          PERFORM pg_notify('collab_task', json_build_object(
              'source_org', NEW.org_id,
              'doc_id', NEW.id,
              'doc_type', 'IPO'
          )::text);
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      ```

---

## 2. 直运协同：物流与所有权分离 (Drop Shipping)

### 企业痛点
“货直接从工厂发给客户了，中间销售公司的库存账怎么平？财务怎么挂账？”。

### 开发逻辑点
- **逻辑库存节点 (Logical Inventory)**: 
    - 开发者需处理“所有权转移”逻辑。
    - **单据流**: 
        - 1. B 组织（工厂）生成 `Drop_Ship_Shipment`。
        - 2. 系统自动触发 A 组织（销售公司）的 `Virtual_Receipt` 和 `Virtual_Shipment`。
- **价差处理**: 
    - A 卖给客户 100 元，B 卖给 A 80 元。开发者需确保 A 组织的凭证上正确反映这 20 元的内部利润。
- **技术实现建议**: 
    - 使用 **UNLOGGED TABLE** 处理临时的、仅用于计算的虚拟库存对冲数据，提升高并发直运场景下的写入性能。
    - 使用 `JSONB` 存储直运链路中的多级分润协议，方便动态调整。

---

## 3. 跨组织委外协同 (Cross-Org Subcontracting)

### 企业痛点
**“A 工厂把零件发给 B 工厂加工，这在系统里到底是生产订单还是采购订单？”**。

### 开发逻辑点
- **双重身份映射**: 
    - 开发者需将 B 组织映射为 A 组织的 `Internal_Supplier`。
    - **开发逻辑**: 
        - A 组织：下达 `Subcontract_MO`。
        - B 组织：自动生成 `Standard_MO`。
- **物料追溯**: 
    - 开发者必须实现跨组织的 `Lot_Traceability`。确保 A 组织发出的批次号在 B 组织加工后，能正确带回给 A 组织。
- **技术实现建议**: 
    - 利用 PostgreSQL 的 **Recursive CTE** 实现跨组织的批次全生命周期追溯，穿透组织边界。
    - **示例代码**:
      ```sql
      -- 跨组织递归追溯物料批次
      WITH RECURSIVE cross_org_trace AS (
          SELECT lot_id, org_id, parent_lot_id FROM lot_master WHERE lot_id = :target_lot
          UNION ALL
          SELECT l.lot_id, l.org_id, l.parent_lot_id FROM lot_master l
          JOIN cross_org_trace t ON l.lot_id = t.parent_lot_id
      )
      SELECT * FROM cross_org_trace;
      ```

---

## 4. 内部交易价格与结算 (Internal Pricing)

### 企业痛点
“内部价格经常变，每次都要两边同时改，太痛苦了”。

### 开发逻辑点
- **全局价表模型**: 
    - 开发者需支持 `Inter-Company_Price_List`。
    - **取价优先级**: 1. 协议特定价 -> 2. 成本加成价 -> 3. 标准转让价。
- **自动对账引擎**: 
    - 开发者需构建一个 `Unmatched_Internal_Transaction_View`，实时扫描 A 组织已收货但 B 组织未发货，或金额不一致的异常。
- **技术实现建议**: 
    - 使用 **Materialized View (物料化视图)** 定期刷新内部交易对账结果，降低实时查询对核心库的压力。
    - 利用 **Postgres_fdw** (Foreign Data Wrapper) 如果不同组织的数据分布在不同的数据库实例上，实现跨实例的联邦查询对账。
    - **示例代码**:
      ```sql
      -- 创建物料化视图加速内部对账
      CREATE MATERIALIZED VIEW mv_internal_reconcile AS
      SELECT a.doc_no, a.amount as buy_amt, b.amount as sell_amt
      FROM purchase_order a
      JOIN sales_order b ON a.src_guid = b.guid
      WHERE a.is_internal = true AND a.amount != b.amount;
      ```

---

## 5. 开发者 Checklist

- [ ] **分布式事务**: 跨组织单据生成必须使用 `TransactionScope` 或 `Two-Phase Commit`，防止 A 生成了但 B 没生成。
- [ ] **汇率一致性**: 跨币种协同（如香港公司卖给深圳工厂）时，开发者是否使用了统一的 `Corporate_Exchange_Rate`？
- [ ] **取消与回滚**: B 组织的销售订单取消时，开发者必须强制检查并同步取消 A 组织的采购订单。
- [ ] **税务合规**: 内部交易是否正确生成了增值税/关税凭证？
- [ ] **性能**: 协同插件应尽量采用异步消息队列处理，避免由于对方组织数据库死锁导致当前组织操作卡死。
