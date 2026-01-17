# 销售执行 (Sales Process) - 开发者详尽指南

## 概述
销售执行是企业的“现金流入口”。开发者必须理解：销售订单（SO）是整个 ERP 的**第一动力源**。它不仅是一张单据，它会像涟漪一样扩散到生产（MO）、采购（PO）和物流（Logistics）。

---

## 1. 销售订单的需求驱动逻辑 (Requirement Drive)

### 企业痛点
**“销售下了一个单，生产不知道，采购也不知道，直到客户催货才发现没排产”**。

### 开发逻辑点
- **MRP/LRP 触发器**: 
    - 开发者需确保 SO 保存并核准后，相关记录能被 `Demand_Engine` 实时捕获。
    - **逻辑**: `INSERT INTO Demand_Pool (Order_ID, Item_ID, Qty, Required_Date, Priority)`。
- **ATO (Assemble-to-Order) 模式**: 
    - 对于定制化产品，开发者需在 SO 核准时自动调用 `Auto_BOM_Explosion`。
    - **逻辑**: 根据客户选配的参数，实时生成一个临时的 `Production_BOM` 并挂载到该 SO 行。

---

## 2. 出货申请与物流锁定 (Shipping & Allocation)

### 企业痛点
“销售员 A 开了单，去仓库拿货，发现仓库刚把这批货发给销售员 B 的客户了，明明 A 先下的单”。

### 开发逻辑点
- **硬预留逻辑 (Hard Allocation)**: 
    - 开发者需在“出货申请单”核准时，执行 `Inventory_Lock`。
    - **数据库逻辑**: `UPDATE Stock SET Locked_Qty = Locked_Qty + :ReqQty WHERE Bin_ID = :BinID`。
- **多订单合并策略**: 
    - 开发者需实现一个“拼单算法”。
    - **逻辑**: 将同一送货地址、同一承运商的多个 SO 行自动聚合到一张 `Shipping_Notice`，以降低运输成本。

---

## 3. RMA 退货闭环控制 (Return Management)

### 企业痛点
**“客户退了 10 个货，财务按现在的原价退的款，结果这批货是去年促销时打 5 折买的，公司亏大了”**。

### 开发逻辑点
- **原单追溯强关联**: 
    - 开发者需在 RMA（退货授权）界面强制要求 `Reference_Order`。
    - **取价逻辑**: `RMA_Price = SELECT Unit_Price FROM SO_Lines WHERE SO_ID = :RefID AND Item_ID = :ItemID`。
- **状态联动**: 
    - 开发者需确保：RMA 核准 -> 仓库收到货（入库）-> 自动生成 `AR_Credit_Memo`（红字账单）。

---

## 4. 信用控制与拦截机制 (Credit Control)

### 企业痛点
“那个客户已经欠款 100 万了，销售还在给他发货，最后变成了呆账”。

### 开发逻辑点
- **分布式信用检查**: 
    - 在 SO 保存前，开发者必须调用 `Credit_Check_Service`。
    - **算法**: `IF (Current_Order_Amt + Outstanding_AR > Credit_Limit) THEN SET Status = 'Hold'`。
- **审批流解锁**: 
    - 开发者需设计“特批”逻辑。当信用超限时，单据进入 `Finance_CEO_Approval` 队列，只有高层签字后，开发者才允许修改单据状态为 `Approved`。

---

## 5. 开发者 Checklist

- [ ] **多组织销售**: A 组织销售，B 组织出货，开发者是否处理了 `Internal_Trade_Pricing`（内部交易价）？
- [ ] **附件一致性**: 合同扫描件必须随 SO 流转到出货环节，供仓库核对特殊包装要求。
- [ ] **取消逻辑**: 如果 SO 已生成 MO 且已领料，开发者必须禁止 SO 的直接取消，强制走 `Change_Order` 流程。
- [ ] **接口幂等性**: 对接电商平台（如天猫、京东）时，订单抓取接口必须根据 `External_Order_ID` 做唯一性校验。
