# 财务基础 (GL/AR/AP) - 开发者详尽指南

## 概述
财务模块是 ERP 的“真值来源”。在开发视角下，财务是对业务数据的**合规化映射与多维汇总**。开发者必须利用 PostgreSQL 的**强一致性事务**、**行级安全策略 (RLS)** 和**高精度数值类型**，确保业务单据（Sub-ledger）与总账（General Ledger）之间的绝对同步。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **业财脱节**：业务单据审核了，但财务不知道，或者凭证科目选错了。 | **AEP 映射引擎 (AEP_Engine)**：利用 JSONB 存储入账规则，在业务审核事务中“同步生成”或“异步抛送”凭证。 |
| **核销混乱**：一笔收款分多次核销多张发票，余额算错，导致客户投诉。 | **原子核销模型 (Atomic_Clearing)**：使用 `fi_clearing_detail` 中间表记录每一笔核销足迹，并在 `SERIALIZABLE` 隔离级别下更新余额。 |
| **关账后乱改数据**：财务月结已完成，业务却在修改上个月的单据，导致报表不平。 | **期间硬拦截 (Period_Lock)**：在全局 `BeforeUpdate` 触发器中，强制校验单据日期所属期间的 `is_closed` 状态。 |
| **数据被篡改**：已过账凭证被开发人员通过后台修改，审计失败。 | **RLS 防篡改策略**：利用 Row Level Security，对 `is_posted = true` 的凭证行禁止任何 `UPDATE/DELETE` 操作。 |

---

## 1. 总账 (GL) 与 AEP 规则匹配

### 业务场景
销售出库单审核后，需自动生成：`借：主营业务成本，贷：库存商品`。

### 技术实现建议
- **规则检索**: 使用 `jsonb_path_query` 快速定位科目。
- **示例代码**:
  ```sql
  -- 根据业务属性匹配科目
  SELECT account_id FROM acc_mapping_rules 
  WHERE event_type = 'Sales_Issue' 
    AND rule_json @@ '$.item_group == "Electronics" && $.org_id == 100';
  ```

---

## 2. 精密核销与余额回写 (Clearing Logic)

### 业务场景
客户付了 10,000 元，其中 5,000 核销发票 A，3,000 核销发票 B，2,000 留作预收。

### 开发规范
- **禁止直接改余额**: 余额必须通过核销明细表（Detail）累加得出。
- **一致性锁**: 核销时必须同时锁定“发票行”和“收款行”。
- **示例代码**:
  ```sql
  -- 原子核销事务
  BEGIN;
  -- 1. 锁定发票与收款记录
  SELECT id FROM fi_invoice WHERE id = :inv_id FOR UPDATE;
  SELECT id FROM fi_payment WHERE id = :pay_id FOR UPDATE;

  -- 2. 插入核销明细
  INSERT INTO fi_clearing_detail (inv_id, pay_id, amount) VALUES (:inv_id, :pay_id, :amt);

  -- 3. 更新发票未核销余额（利用增量扣减）
  UPDATE fi_invoice SET open_amount = open_amount - :amt WHERE id = :inv_id;
  COMMIT;
  ```

---

## 3. 期间控制与防篡改 (Period & Security)

### 业务场景
确保财务结账后的历史数据绝对安全。

### 技术实现建议
- **期间状态校验**:
  ```sql
  -- 触发器：拦截已关账期间的写入
  CREATE OR REPLACE FUNCTION fn_check_period_status() RETURNS TRIGGER AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM fi_period WHERE period_name = to_char(NEW.doc_date, 'YYYY-MM') AND is_closed = true) THEN
      RAISE EXCEPTION 'ERR_PERIOD_CLOSED: 该期间已结账，禁止操作';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  ```
- **RLS 策略**:
  ```sql
  -- 保护已过账凭证
  ALTER TABLE gl_voucher ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p_voucher_immutable ON gl_voucher
  FOR UPDATE USING (is_posted = false); -- 只有未过账的才能修改
  ```

---

## 4. 汇兑损益与数值精度 (Precision)

### 业务场景
外币应收账款在月末按新汇率折算，产生的差异计入损益。

### 开发规范
- **数值类型**: 统一使用 `numeric(24, 12)`。
- **调汇逻辑**: 
  ```sql
  -- 计算汇兑损益
  SELECT 
    invoice_id,
    (amount_foreign * :new_rate - amount_local) as exchange_diff
  FROM fi_ar_invoice WHERE currency_id != :base_currency;
  ```

---

## 5. 开发者 Checklist

- [ ] **借贷平衡**: 凭证保存时是否强制校验 `SUM(debit) == SUM(credit)`？
- [ ] **精度对齐**: 业务单据生成的本币金额，是否与凭证行的金额完全一致（分毫不差）？
- [ ] **期间拦截**: 是否在所有财务单据的 `BeforeSave` 中加入了期间开关校验？
- [ ] **核销回滚**: 弃审收款单时，是否能同步级联删除核销明细并恢复发票余额？
- [ ] **审计足迹**: 核心余额表（AR/AP/GL）的变动是否记录了 `source_doc_type` 和 `source_doc_id`？
- [ ] **多币种**: 涉及外币时，是否同时存储了交易汇率（ExchangeRate）和记账汇率（BookingRate）？
- [ ] **性能**: 核销明细表数据量大时，是否对 `invoice_id` 和 `payment_id` 建立了复合索引？
