# 公共基础 (Common Base) - 开发者详尽指南

## 概述
公共基础模块（CBO-Base）是整个 ERP 系统的“基石”。在涉及币种、期间、税制等核心逻辑时，开发者必须利用数据库的**强类型约束**和**范围校验**特性，确保业务数据的绝对严谨。

---

## 1. 币种与汇率 (Currency & Exchange Rate)

### 业务场景
全球化企业每天都在处理不同币种。汇率是随时间波动的，采购、付款等不同时点的汇率差异会产生“汇兑损益”。

### 开发规范
- **金额存储**: 必须同时存储 `Amount_TC` (交易币) 和 `Amount_BC` (本位币)。
- **精度陷阱**: 
    - 严禁使用 `float` 或 `real`。
    - **技术实现建议**: 必须使用 PostgreSQL 的 `numeric(20, 8)` 或更高精度类型。在进行本外币转换时，应在数据库函数或 Service 层统一处理舍入逻辑（Rounding）。
- **汇率时效**:
    - **技术实现建议**: 汇率表推荐使用 `daterange` 记录有效期。这配合**排除约束 (Exclusion Constraints)** 可以确保同一币种对在同一时间内只有一条有效汇率。
    - **示例代码**:
      ```sql
      -- 在数据库层强制汇率有效期不重叠
      ALTER TABLE currency_rate ADD CONSTRAINT rate_time_no_overlap 
      EXCLUDE USING gist (from_currency WITH =, to_currency WITH =, validity_period WITH &&);
      ```

---

## 2. 会计日历 (Accounting Calendar)

### 业务场景
财务期间（Period）不一定等同于自然月。财务结账后，必须严禁任何业务单据倒填到已关闭的期间。

### 开发规范
- **状态控制**: 期间分为 `Open`（可录入）、`Closed`（已关账）、`Future`（预开）。
- **期间判定**: 所有业务单据必须根据其“业务日期”反查对应的 `PeriodID`。
- **技术实现建议**: 
    - 使用 `daterange` 存储期间的起止时间。
    - 编写数据库函数 `fn_get_period(org_id, busi_date)`，利用索引快速定位日期所属期间。
    - 利用 PostgreSQL 的 **Check 约束** 或 **Trigger** 强制校验：当单据日期所属期间状态为 `Closed` 时，禁止 `INSERT` 或 `UPDATE`。
    - **示例代码**:
      ```sql
      -- 使用 daterange 快速查找所属期间
      SELECT period_id FROM acc_calendar 
      WHERE org_id = :org_id AND period_range @> :busi_date::date;
      ```

---

## 3. 税制与税率 (Taxation)

### 业务场景
同一个物料，卖给内贸、外贸或作为礼品赠送，其计税逻辑完全不同。

### 开发规范
- **计税平账**: 必须满足 `不含税价 + 税额 = 含税价`。由于舍入差异，最后一行明细通常需要“尾差配平”。
- **灵活配置**: 税制规则应支持动态扩展。
- **技术实现建议**: 
    - 使用 `JSONB` 存储复杂的计税公式或阶梯税率，利用 `jsonb_path_query` 实现动态计税引擎。
    - 核心税率表同样建议使用 `daterange` 管理政策有效期，防止税率跳变导致的计算错误。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 存储计税逻辑
      SELECT (data->>'rate')::numeric * :amount as tax_amount 
      FROM tax_rules WHERE tax_code = :tax_code;
      ```

---

## 4. 开发者 Checklist

- [ ] **精度对齐**: 数据库金额字段是否全部定义为 `numeric` 类型？
- [ ] **时段重叠**: 汇率和期间表是否使用了 `EXCLUDE` 约束防止时间重叠？
- [ ] **期间强校验**: 在单据保存逻辑中，是否调用了期间状态校验函数？
- [ ] **尾差处理**: 单据合计逻辑是否包含了含税/不含税的尾差配平算法？
- [ ] **性能**: 涉及大量汇率转换的报表，是否使用了数据库端的连接缓存或物化视图？
