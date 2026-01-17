# 财务基础 (GL/AR/AP) - 开发者详尽指南

## 概述
财务模块是 ERP 的“真值来源”。在开发视角下，财务是对业务数据的**合规化映射与多维汇总**。开发者必须利用 PostgreSQL 的**强一致性事务**、**行级安全策略 (RLS)** 和**高精度数值类型**，确保业务单据（Sub-ledger）与总账（General Ledger）之间的绝对同步与数据防篡改。

---

## 1. 总账 (GL) 与自动会计平台 (AEP)

### 业务场景
“业务一小步，财务一大步”。业务单据审核后，系统必须根据复杂的入账规则自动生成会计分录。

### 技术实现建议
    - **事件捕获**: 利用 PostgreSQL 的 **Logical Decoding** 监听业务单据状态位（如 `status = 'Approved'`），异步触发 AEP 服务。
    - **规则存储**: 使用 `JSONB` 存储复杂的入账映射规则，利用 `jsonb_path_query` 快速匹配最符合条件的会计科目。
    - **示例代码**:
      ```sql
      -- 使用 jsonb_path_query 匹配入账规则
      SELECT account_id FROM accounting_rules 
      WHERE rules @> '{"item_category": "Electronics"}'::jsonb 
        AND jsonb_path_exists(rules, '$.customer_ranks[*] ? (@ == "VIP")');
      ```

---

## 2. 应收 (AR) 与 应付 (AP) 的精密核销 (Clearing)

### 业务场景
处理 1:N、N:1 或 N:M 的收付款与发票对账，并精确回写未核销余额。

### 开发规范
- **核销原子性**: 收付款与发票的核销必须在同一个数据库事务中完成。
- **余额一致性**: 发票的“待核销金额”必须与明细表的累加值严格相等。
- **技术实现建议**: 
    - **并发控制**: 使用 **SERIALIZABLE (可序列化)** 事务隔离级别处理核销逻辑，从根本上杜绝在高并发收付款场景下的余额计算偏差。
    - **实时对账视图**: 利用 **Window Functions (窗口函数)** 构建实时余额分析模型，通过 `SUM(clearing_amt) OVER (PARTITION BY invoice_id)` 动态呈现每张发票的核销进度。
    - **示例代码**:
      ```sql
      -- 计算发票的实时余额
      SELECT 
          invoice_id, amount,
          amount - SUM(clearing_amount) OVER (PARTITION BY invoice_id) as remaining_balance
      FROM fi_ar_clearing_details;
      ```

---

## 3. 跨组织往来与自动对冲 (Inter-Company)

### 业务场景
集团内部公司间的买卖行为，需自动生成双方的对等分录。

### 开发规范
- **对等性校验**: 借方组织生成的内部应收，必须与贷方组织生成的内部应付在金额、币种上完全一致。
- **技术实现建议**: 
    - **分布式查询**: 若不同组织分布在不同数据库实例，利用 PostgreSQL 的 **postgres_fdw (外部数据包装器)** 实现跨库的对账校验。
    - **一致性事务**: 利用 **Two-Phase Commit (2PC)** 确保跨组织分录生成要么同时成功，要么同时回滚。
    - **示例代码**:
      ```sql
      -- 创建外部表引用另一个组织的账簿数据
      CREATE FOREIGN TABLE other_org_ledger (
          account_id int, debit numeric, credit numeric
      ) SERVER other_org_db OPTIONS (table_name 'gl_ledger');
      ```

---

## 4. 汇兑损益与数值精度 (Exchange & Precision)

### 业务场景
期末根据最新汇率对所有外币科目进行调汇，计算汇兑损益。

### 开发规范
- **高精度计算**: 汇率、本币金额、外币金额必须使用 `numeric`。
- **数据防篡改**: 凭证一旦过账（Posted），物理记录必须变为只读。
- **技术实现建议**: 
    - **数值类型**: 统一使用 `numeric(38, 12)`，确保在全球多币种换算场景下不产生舍入误差。
    - **只读锁定**: 利用 PostgreSQL 的 **Row Level Security (RLS)**。定义策略：当 `posted_status = true` 时，拒绝任何用户的 `UPDATE` 或 `DELETE` 请求，仅允许通过红字冲销（反向凭证）进行修正。
    - **示例代码**:
      ```sql
      -- 开启 RLS 保护已过账凭证
      ALTER TABLE gl_voucher ENABLE ROW LEVEL SECURITY;
      CREATE POLICY voucher_readonly_policy ON gl_voucher
      FOR UPDATE USING (posted_status = false);
      ```

---

## 5. 开发者 Checklist

- [ ] **平衡校验**: 凭证保存前，数据库层是否通过 **Trigger (触发器)** 强制校验 `SUM(debit) == SUM(credit)`？
- [ ] **期间保护**: 是否在 `CHECK` 约束中加入了期间状态判断，防止凭证记入已关账期间？
- [ ] **科目有效性**: 凭证行中的科目 ID 是否配置了外键约束，并校验了“允许过账”标识？
- [ ] **并发性能**: 对于大规模批处理（如期末自动转账），是否利用了 **Parallel Query** 提升损益类科目的汇总速度？
- [ ] **审计追踪**: 财务核心表是否利用 `JSONB` 记录了所有字段级别的变更历史（Audit Log）？
