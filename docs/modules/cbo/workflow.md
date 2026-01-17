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

## 4. 严谨性校验：反审核与幂等 (Consistency)

### 业务场景
用户误操作或撤回申请。系统必须能够安全地执行“反审核”逻辑，并防止重复点击导致的幂等性问题。

### 开发规范
- **反审核链条检查**: 弃审时必须检查下游是否有已执行单据。若有，则必须先弃审下游，防止业务逻辑断层。
- **幂等设计**: 所有的审批操作必须携带唯一 `RequestID` 或 `Version` 标识。
- **技术实现建议**: 
    - **乐观锁控制**: 每一条单据增加 `version` 字段，更新状态时必须执行 `WHERE version = :old_version`。
    - **日志钩子**: 利用数据库 **Trigger (触发器)** 自动记录操作日志，确保审计信息的生成与业务逻辑在同一个原子事务中。
    - **示例代码**:
      ```sql
      -- 使用版本号防止并发冲突
      UPDATE sales_order SET status = 'Draft', version = version + 1 
      WHERE id = :id AND version = :old_version;
      ```

---

## 5. 开发者 Checklist

- [ ] **递归查询**: 审批链条寻找主管逻辑是否使用了 `WITH RECURSIVE` 以提升性能？
- [ ] **快照审计**: 审批历史是否包含了 `JSONB` 格式的单据快照？
- [ ] **状态机校验**: 数据库层是否通过 `CHECK` 约束或状态枚举限制了非法的状态跳转？
- [ ] **实时性**: 是否利用了 `NOTIFY` 或消息队列实现审批任务的秒级通知？
- [ ] **幂等处理**: 审批接口是否通过 `version` 字段或唯一请求标识防止了重复提交？
