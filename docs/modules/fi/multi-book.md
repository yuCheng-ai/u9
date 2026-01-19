# 多账簿核算体系 (Multi-Book) - 开发者详尽指南

## 概述
多账簿（Multi-Book）是解决“财务两张脸”的技术方案。在开发者眼中，这是一种**一写多读（Write Once, Post Multiple）**的架构。它确保了同一笔业务在不同会计准则（CAS, IFRS, US GAAP）下的数据强一致性。

---

## 业务痛点与开发对策

| 业务痛点 | 技术对策 |
| :--- | :--- |
| **重复录入**：为了满足不同上市地的准则，财务人员要录入多遍凭证。 | **AEP 自动分流引擎 (AEP_Router)**：业务单据进入 AEP 后，利用 JSONB 存储的“路由规则栈”，根据预设准则自动并行生成多套账簿凭证。 |
| **差异难对平**：中国准则和国际准则对研发支出的定义不同，导致资产总额对不上。 | **差异账簿模式 (Adjustment Ledger)**：采用“主账簿 + 差异项”模式，报表查询时利用 `UNION ALL` 动态合并，减少 50% 的冗余存储。 |
| **折算损益（FCTR）计算难**：跨国集团月末按不同汇率折算，借贷不平。 | **自动挤平算法 (Rounding_Offset)**：在折算事务末尾自动检测借贷差额，并将其记入指定的“折算差额（FCTR）”科目。 |
| **数据同步断裂**：主账记录改了，副账没改，导致审计失败。 | **两阶段提交 (2PC) / 原子事务**：将所有账簿的凭证生成/修改包裹在同一个数据库事务内，确保要么全成功，要么全失败。 |

---

## 1. 核心模型：主账簿与差异账簿 (Delta Storage)

### 业务场景
企业在 A 股上市（CAS），同时在香港上市（IFRS）。

### 技术实现建议
- **动态视图合并**:
  ```sql
  -- IFRS 账簿 = CAS 账簿数据 + IFRS 专用差异项
  CREATE VIEW v_ifrs_ledger AS
  SELECT account_id, amount, 'CAS' as source FROM ledger_cas
  UNION ALL
  SELECT account_id, amount, 'IFRS_DELTA' as source FROM ledger_adjustments 
  WHERE target_gaap = 'IFRS';
  ```

---

## 2. AEP 路由与分流逻辑 (AEP Routing)

### 业务场景
销售发票产生时，系统需自动生成两张凭证：一张入主账，一张入管理账（按内部管理成本）。

### 开发规范
- **路由规则配置**: 使用 JSONB 存储路由逻辑。
  ```json
  {
    "event": "Sales_Invoice",
    "ledgers": [
      {"ledger_id": "L001", "rule_id": "R_CAS_SALE"},
      {"ledger_id": "L002", "rule_id": "R_MGMT_SALE"}
    ]
  }
  ```
- **并发锁**: 在生成凭证前，必须使用 `SELECT ... FOR UPDATE` 锁定源业务单据，防止并发重写。

---

## 3. FCTR 折算差额计算 (Currency Translation)

### 业务场景
子公司本位币（Functional Currency）是越南盾，总部要求看人民币报表。

### 技术实现建议
- **挤平逻辑**: 开发者必须处理折算后由于小数位截断导致的 0.01 差异。
  ```sql
  -- 计算折算后的借贷差异
  WITH converted_sum AS (
      SELECT 
        sum(dr_local) as total_dr, 
        sum(cr_local) as total_cr 
      FROM tmp_voucher_lines
  )
  INSERT INTO tmp_voucher_lines (account_id, dr_local)
  SELECT :fctr_account_id, (total_cr - total_dr) 
  FROM converted_sum 
  WHERE total_cr != total_dr;
  ```

---

## 4. 严谨性校验：弃审联动 (Un-approve Sync)

### 业务场景
业务单据（如采购发票）弃审时，所有关联账簿的凭证必须同步回滚。

### 技术实现建议
- **反审核拦截**: 
  ```sql
  -- 检查任一账簿是否已记账（Posted）
  IF EXISTS (
    SELECT 1 FROM gl_voucher 
    WHERE source_doc_id = :id AND status = 'Posted'
  ) THEN
    RAISE EXCEPTION 'ERR_UNAPPROVE_FORBIDDEN: 关联的某套账簿凭证已记账，请先冲销凭证';
  END IF;
  ```
- **同步清理**: 在同一个事务内删除所有账簿的草稿态凭证。

---

## 5. 开发者 Checklist

- [ ] **科目映射**: 不同账簿的科目体系可能不同，系统是否实现了 `Account_Mapping_Table`？
- [ ] **事务原子性**: 并行生成 N 套账簿凭证时，是否包裹在同一个 `BEGIN...COMMIT` 块内？
- [ ] **审计足迹**: 调整账簿的凭证是否记录了“差异原因”和“原始凭证 ID”？
- [ ] **分区性能**: 凭证表数据量巨大时，是否按 `ledger_id` 和 `fiscal_period` 进行了物理分区？
- [ ] **汇率时效**: 资产负债类科目的折算汇率是否严格取自“期间末日”的汇率？
- [ ] **AEP 性能**: 是否支持异步生成副账簿凭证，以减轻主业务操作的响应时间？
