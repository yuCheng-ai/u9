# 销售价格体系 - 开发者详尽指南

## 概述
销售价格是企业的“盈利边界”。开发者必须理解：销售价格模型是一个**多因子复合逻辑**。它不是从数据库取一个 `Price` 字段那么简单，而是通过一系列**路由规则、优先级、阶梯算法、以及折扣叠加**最终计算出的结果。

---

## 1. 取价引擎算法 (Pricing Search Engine)

### 企业痛点
**“客户抱怨我给他的价格比上个月贵了，销售员说他记错了，系统里也没个自动取价逻辑”**。

### 开发逻辑点
- **瀑布式搜索策略 (Waterfall Search)**: 
    - 开发者需实现一个可配置的搜索链条：
        - `Step 1`: 匹配“特价协议” (Promotion/Contract)。
        - `Step 2`: 匹配“客户专属价表”。
        - `Step 3`: 匹配“客户等级/区域价表”。
        - `Step 4`: 匹配“全局标准价表”。
    - **开发注意**: 搜索算法必须具备“熔断机制”，一旦在高优先级匹配到价格，立即停止搜索。
- **日期与状态校验**: 
    - 接口必须校验 `Price_Line.Status == 'Approved'` 且 `CurrentDate BETWEEN StartDate AND EndDate`。

---

## 2. 阶梯价格与批量计算 (Volume Tiering)

### 企业痛点
“买 1 个和买 1000 个的价格是不一样的，开发者如果处理不好，销售员录单时得手动计算，效率极低”。

### 开发算法
- **区间查找算法**: 
    - 开发者需维护 `Price_Break` 表。
    - **逻辑**: `SELECT Unit_Price FROM Price_Breaks WHERE Min_Qty <= :OrderQty ORDER BY Min_Qty DESC LIMIT 1`。
- **阶梯模式支持**: 
    - **全额阶梯**: 1000 个全部按 0.8 元。
    - **超额阶梯**: 前 500 个按 1 元，后 500 个按 0.8 元（类似个人所得税）。
    - 开发者需在价表头定义 `Tier_Type`。

---

## 3. 多重折扣叠加逻辑 (Discount Stacking)

### 企业痛点
**“又有节日折扣 9 折，又有会员折扣 95 折，到底是 85 折还是 85.5 折？”**。

### 开发逻辑点
- **折扣类型定义**: 
    - `Additive` (相加): `10% + 5% = 15% off`。
    - `Compounded` (相乘): `0.9 * 0.95 = 0.855`。
- **折扣序列 (Discount Sequence)**: 
    - 开发者需为每一层折扣分配一个 `Sequence_ID`，确保计算顺序的一致性。
    - **公式**: `Final_Price = Base_Price * (1 - Discount1) * (1 - Discount2) ...`。

---

## 4. 价格强控与最低限价 (Price Ceiling/Floor)

### 企业痛点
“销售为了拿提成，故意把价格压得很低，结果公司亏本卖货”。

### 开发逻辑点
- **底线校验**: 
    - 开发者需在 SO 审核 API 中强制接入 `Floor_Price_Check`。
    - **逻辑**: `IF (Final_Price < Cost_Price * (1 + Min_Margin)) THEN REJECT_OR_TRIGGER_CEO_APPROVAL`。
- **只读字段控制**: 
    - 对于某些标准化行业，开发者应支持“价格不可编辑”配置，强制系统取价，严禁人工改动。

---

## 5. 开发者 Checklist

- [ ] **币种自动换算**: 价表是美元，订单是人民币，开发者是否调用了 `Currency_Exchange_Service`？
- [ ] **精度处理**: 销售单价通常涉及“四舍五入”或“截断”逻辑，需与财务 `Round_Policy` 保持严格一致。
- [ ] **性能**: 取价逻辑发生在 SO 录入的高频时段，必须针对 `Item+Customer` 建立复合索引。
- [ ] **历史追溯**: 所有的调价行为必须记录 `Price_Audit_Log`。
