# 集团管控与合并报表 (Group Control) - 开发者详尽指南

## 概述
集团管控是 ERP 的“指挥塔”。开发者必须理解：集团管控的核心是**主数据的一致性**和**内部交易的自动抵消**。没有一致的主数据，合并报表就是“垃圾进，垃圾出” (GIGO)。

---

## 1. 主数据管控模式 (Master Data Governance)

### 企业痛点
**“同样的物料，上海公司叫‘螺丝’，北京公司叫‘紧固件’，集团想看总库存根本看不了”**。

### 开发逻辑点
- **管控策略引擎**: 
    - 开发者需在主数据实体上实现 `Governance_Policy`。
    - **模式 1: 强管控 (Centralized)**: 分子公司只有只读权限，所有修改必须在集团组织进行，通过 `Data_Push_Job` 分发。
    - **模式 2: 申请审批 (Workflow-based)**: 分子公司发起 `Master_Data_Request`，总部核准后自动同步。
- **全局唯一 ID (Global_UID)**: 
    - 开发者必须确保跨组织的主数据具有相同的 `Mapping_Key`，以便在合并报表时进行 `JOIN` 操作。
- **技术实现建议**: 
    - 使用 **JSONB** 存储复杂的管控策略。例如，可以定义哪些字段由总部控制，哪些允许分公司修改。
    - 利用 PostgreSQL 的 **Logical Decoding** 或 **Subscription** 机制实现主数据从集团到分公司的实时、高可靠同步。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 定义主数据字段管控权限
      -- 'R' 为只读，'W' 为可写
      SELECT policy_data->>'item_name' as name_perm, policy_data->>'spec' as spec_perm
      FROM governance_policy WHERE org_id = :org_id AND entity_type = 'Item';
      ```

---

## 2. 内部交易自动抵消 (Inter-company Elimination)

### 企业痛点
“月底合并报表，为了抵消内部往来，财务要手工录入几百行抵消分录，还要到处找对账差异”。

### 开发逻辑点
- **抵消标记 (Elimination_Tag)**: 
    - 开发者在处理协同单据（如内部 PO/SO）产生的凭证时，必须强制打上 `Is_Internal = True` 标记，并记录 `Counter_Org_ID`。
- **自动抵消引擎算法**: 
    - **往来抵消**: `SUM(AR where Partner == Org_B) - SUM(AP where Partner == Org_A)`。
    - **损益抵消**: 开发者需追踪内部交易的“未实现利润”。
    - **算法**: `IF (Item_Still_In_Inventory) THEN 抵消该部分利润 ELSE 确认利润`。
- **技术实现建议**: 
    - 使用 PostgreSQL 的 **Window Functions (窗口函数)** 进行内部对账，快速识别金额不匹配的交易。
    - 使用 **Recursive CTE** 追踪内部利润在多级组织间的流转路径。
    - **示例代码**:
      ```sql
      -- 快速识别内部往来差异
      SELECT partner_org, SUM(balance) FILTER (WHERE acc_type = 'AR') as ar_sum,
             SUM(balance) FILTER (WHERE acc_type = 'AP') as ap_sum
      FROM gl_ledger WHERE is_internal = true
      GROUP BY partner_org
      HAVING SUM(balance) FILTER (WHERE acc_type = 'AR') != SUM(balance) FILTER (WHERE acc_type = 'AP');
      ```

---

## 3. 合并报表穿透 (Consolidation Drill-down)

### 企业痛点
**“合并报表上的 1000 万应收账款，我想知道具体是哪几家子公司欠的，每家欠了多少”**。

### 开发逻辑点
- **多级聚合视图**: 
    - 开发者需构建一个 `Consolidated_Ledger_View`。
    - **逻辑**: 通过 `Union All` 各组织的余额表，并应用 `Elimination_Rules`。
- **穿透路径设计**: 
    - 集团汇总数 -> 组织明细数 -> 组织原始凭证 -> 协同业务单据。
    - 开发者需维护 `Origin_Org_ID` 和 `Origin_Voucher_ID` 的链条。
- **技术实现建议**: 
    - 针对海量余额表数据，使用 PostgreSQL 的 **Table Partitioning (表分区)**，按会计年度或组织进行分区，显著提升查询性能。
    - 使用 **Materialized View** 存储中间合并结果，支持“秒级”出表。
    - **示例代码**:
      ```sql
      -- 创建按年度分区的合并余额表
      CREATE TABLE gl_consolidated_ledger (
          year int, org_id int, account_id int, balance numeric
      ) PARTITION BY RANGE (year);
      ```

---

## 4. 集团政策下达与控制 (Group Policy)

### 企业痛点
“集团要求差旅费报销不能超过 500 元，但分子公司各行其是，总部管不住”。

### 开发逻辑点
- **全局参数继承**: 
    - 开发者需设计 `Parameter_Inheritance` 模型。
    - **逻辑**: 分子公司默认继承集团的 `Control_Param`，除非集团显式授权 `Allow_Local_Override`。
- **预算硬控制**: 
    - 开发者需实现跨组织的 `Global_Budget_Check` API，支持集团对分公司的费用总额进行远程冻结。
- **技术实现建议**: 
    - 利用 PostgreSQL 的 **Advisory Locks (咨询锁)** 实现跨组织的分布式资源竞争控制（如集团层面的信用配额抢占）。
    - 使用 **Generated Columns** 实时计算分公司的预算执行率，方便总部监控。
    - **示例代码**:
      ```sql
      -- 使用咨询锁确保集团预算扣减的原子性
      SELECT pg_advisory_xact_lock(:group_budget_id);
      UPDATE group_budgets SET used_amount = used_amount + :req_amount WHERE id = :group_budget_id;
      ```

---

## 5. 开发者 Checklist

- [ ] **多币种折算 (FCTR)**: 合并时涉及不同本位币，开发者是否正确处理了“外币报表折算差额”？
- [ ] **股权比例**: 抵消时是否考虑了非全资子公司的 `Minority_Interest` (少数股东权益)？
- [ ] **性能**: 合并报表计算涉及海量数据，必须使用存储过程或专用的报表服务器（如 Cube 预计算）。
- [ ] **审计记录**: 所有的抵消分录必须保留 `System_Generated` 标记，严禁人工修改，除非保留完整的 `Audit_Trail`。
