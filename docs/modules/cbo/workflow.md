# 业务流与工作流引擎 (Workflow & Flow) - 开发者详尽指南

## 概述
工作流（Workflow）和业务流（Business Flow）是 ERP 的“血液循环系统”。开发者必须分清两者：**工作流负责决策逻辑**（谁来审），**业务流负责执行逻辑**（单据如何流转）。开发者应利用数据库的**递归查询**、**事务一致性**和**异步通知**特性，构建高效、可追溯的流程引擎。

---

## 1. 业务流：单据的链式转换 (Business Flow)

### 业务场景
“录入即生成”。销售员录入订单，审核后系统应自动在仓库生成出货单。这要求上、下游单据在数据和状态上保持强一致性。

### 技术实现建议
    - **事务保证**: 必须在同一个数据库事务内完成下游创建与上游回写。
    - **元数据映射**: 使用 `JSONB` 存储单据间的字段映射规则（Mapping Rules），实现动态的字段转换逻辑。
    - **变更追踪**: 利用 PostgreSQL 的 **Logical Decoding** 监听单据变更，实现非核心链条单据（如统计类单据）的异步自动生成。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 定义单据映射规则
      -- 销售订单的 `Qty` 映射到出库单的 `PlanQty`
      SELECT (mapping->>'source_field') as src, (mapping->>'target_field') as dest
      FROM flow_mapping WHERE flow_id = :id;
      ```

---

## 2. 工作流：审批决策与状态机 (Approval Workflow)

### 业务场景
“审批逻辑天天变”。今天经理审，明天总监审，且审批条件（如金额、毛利）极度复杂。

### 开发规范
- **规则去代码化**: 严禁在 Java/C# 代码中写 `if (amount > 5000)`。所有审批分支应由表达式引擎驱动。
- **层级关系查询**: 审批流常需查找“发起人的主管”或“分管副总”。
- **技术实现建议**: 
    - **递归组织架构**: 利用 PostgreSQL 的 **Recursive CTE (递归公用表表达式)**，一句话查询出 HR 组织树中的所有汇报对象。
    - **状态控制**: 使用数据库 **枚举类型 (ENUM)** 或状态码字段，配合 **Check 约束**，强制保证单据只能在合法的状态间流转。
    - **示例代码**:
      ```sql
      -- 递归查询汇报链条
      WITH RECURSIVE subordinates AS (
          SELECT id, supervisor_id, name FROM employee WHERE id = :start_emp
          UNION ALL
          SELECT e.id, e.supervisor_id, e.name FROM employee e
          JOIN subordinates s ON s.supervisor_id = e.id
      )
      SELECT * FROM subordinates;
      ```

---

## 3. 性能与一致性：审计与通知 (Audit & Notify)

### 业务场景
大型集团每天有上万笔审批。系统必须记录每一跳的详细轨迹，并实时通知移动端审批人。

### 开发规范
- **全轨迹审计**: 记录每一步的操作人、意见、耗时及单据快照。
- **快照保存**: 审批时的单据关键信息应持久化，防止事后修改导致审计失效。
- **技术实现建议**: 
    - **快照存储**: 使用 `JSONB` 字段存储审批时的单据完整快照（Snapshot），即便后续表结构变更，审计历史依然可读。
    - **实时推送**: 利用 PostgreSQL 的 **NOTIFY/LISTEN** 机制。当审批任务生成时，数据库直接触发异步通知，由 WebSocket 或消息网关推送至用户手机。
    - **示例代码**:
      ```sql
      -- 记录单据审批快照
      INSERT INTO wf_audit_log (doc_id, node_id, snapshot)
      SELECT :doc_id, :node_id, to_jsonb(sales_order.*) FROM sales_order WHERE id = :doc_id;
      ```

---

## 4. 严谨性校验：反审核与全链路弃审 (Consistency)

### 业务场景
- **幂等性**: 防止重复点击导致的多次审批执行。
- **全链路弃审 (Un-approve)**: 当单据已产生下游业务（如销售订单已生成发货单）时，系统需支持“一键反审核”或“逆序弃审”。

### 开发规范
- **逆序依赖检查**: 
    - 严禁直接修改单据状态。
    - 弃审时必须递归检查所有下游单据的状态。如果下游单据已审核或已执行，必须先弃审下游，否则拦截操作。
- **幂等设计**: 所有的审批操作必须携带唯一 `RequestID` 或 `Version` 标识。

### 技术实现建议
- **递归依赖探测**: 利用数据库视图或专门的 `doc_links` 表记录单据溯源关系。
- **原子性操作**: 整个弃审链条必须在一个分布式事务（或 Saga 模式）中完成。
- **示例代码**:
  ```sql
  -- 递归检查下游单据是否可弃审
  WITH RECURSIVE downstream_docs AS (
      SELECT target_id, target_type, status FROM doc_links WHERE source_id = :current_id
      UNION ALL
      SELECT l.target_id, l.target_type, l.status FROM doc_links l 
      JOIN downstream_docs d ON l.source_id = d.target_id
  )
  SELECT count(*) FROM downstream_docs WHERE status NOT IN ('Draft', 'Cancelled');
  -- 如果 count > 0，则禁止弃审当前单据
  ```

---

## 5. 开发者 Checklist

- [ ] **递归查询**: 审批链条寻找主管逻辑是否使用了 `WITH RECURSIVE` 以提升性能？
- [ ] **快照审计**: 审批历史是否包含了 `JSONB` 格式的单据快照？
- [ ] **状态机校验**: 数据库层是否通过 `CHECK` 约束或状态枚举限制了非法的状态跳转？
- [ ] **实时性**: 是否利用了 `NOTIFY` 或消息队列实现审批任务的秒级通知？
- [ ] **幂等处理**: 审批接口是否通过 `version` 字段或唯一请求标识防止了重复提交？
