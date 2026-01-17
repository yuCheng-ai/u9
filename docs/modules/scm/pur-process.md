# 采购执行 (PO Execution) - 开发者详尽指南

## 概述
采购执行是企业“花钱”的过程。开发者必须建立**全链路闭环**意识。每一张采购单（PO）都不是孤立的，它上接需求（PR/MRP），中连物流（Receipt），下通财务（AP）。

---

## 1. 采购申请（PR）的智能路由与预算逻辑

### 企业痛点
**“员工随便买东西，月底财务才发现预算超标了”**。

### 开发逻辑点
- **预算硬核拦截**: 
    - 开发者需在 PR 提交 API 中接入 `Budget_Control_Service`。
    - **逻辑**: `IF (Current_PR_Amount + Used_Budget > Budget_Limit) THEN BLOCK`。
- **需求聚合算法**: 
    - 开发者需实现一个“合并引擎”。
    - **逻辑**: 将同一供应商、同一收货日期的多个 PR 行自动合并为一个 PO，以减少单据处理成本并争取大客户折扣。

---

## 2. 采购订单（PO）的变更与状态控制

### 企业痛点
“订单发给供应商了，结果我们要改期，供应商说没收到通知，货还是发过来了”。

### 开发逻辑点
- **变更工作流 (PO Revision)**: 
    - 开发者严禁允许用户直接修改已核准的 PO 字段。
    - **开发注意**: 必须实现 `PO_Version_Control`。每一次修改需生成 `Revision_Number`，并自动触发 `Supplier_Notification_API`。
- **状态机的严密性**: 
    - 开发者需定义：`Open -> Approved -> Confirmed -> Receiving -> Closed`。
    - **校验**: `IF (PO.Status == 'Closed') THEN REJECT_ANY_RECEIPT`。

---

## 3. 收货与三单匹配逻辑 (Three-way Match)

### 企业痛点
**“供应商发了 100 个，仓库收了 110 个，财务最后付了 120 个人的钱，全乱套了”**。

### 开发逻辑点
- **超收控制算法**: 
    - 开发者需在收货（Receipt）API 中实现：`Max_Allowed_Qty = PO_Qty * (1 + Over_Receipt_Tolerance)`。
- **三单匹配引擎 (Match Engine)**: 
    - 开发者需构建一个三方校验视图：
        - `PO.Qty` vs `Receipt.Qty` vs `Invoice.Qty`。
    - **逻辑**: 只有三者数量和单价在误差范围内，才允许财务进行 `AP_Post`（记账）。

---

## 4. 供应商门户与协同接口 (Portal Integration)

### 企业痛点
“采购员天天给供应商打电话问发货没，效率太低”。

### 开发逻辑点
- **ASN（提前发货通知）集成**: 
    - 开发者需提供 `Create_ASN` 外部接口给供应商。
    - **逻辑**: 供应商在发货时扫码生成 ASN，开发者自动在 ERP 中生成 `In-Transit`（在途）记录。
- **实时看板**: 
    - 开发者需实现一个 `PO_Execution_Dashboard`，实时显示每个 PO 的“已确认、已发货、已入库、已退货”状态。

---

## 5. 开发者 Checklist

- [ ] **多组织结算**: 采购组织 A 替使用组织 B 买货，开发者是否自动触发了内部交易凭证？
- [ ] **计量单位**: 采购单位（吨）与库存单位（公斤）的换算精度，建议使用 `High_Precision_Decimal`。
- [ ] **附件同步**: 采购合同附件是否能在收货环节自动展示给 QC（品质人员）查看？
- [ ] **幂等性**: 外部协同系统多次推送同一个确认状态时，接口需保持幂等。
