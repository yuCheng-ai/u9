# UAP 业务开发平台 (UAP Platform) - 开发者详尽指南

## 概述
UAP 是 U9 cloud 的“基因组”。在开发视角下，UAP 是一个**元数据驱动 (Metadata-Driven)** 的低代码与插件化框架。开发者应利用 PostgreSQL 的**动态模式支持**、**行级安全隔离**和**高并发版本控制**，在保证标准产品稳定的基础上，实现极高灵活性的二次开发。

---

## 1. 实体建模与模式演进 (Modeling & Schema Evolution)

### 业务场景
- **混合存储**: “标准字段不够用，加个字段要动全身”。
- **模式演进 (Schema Evolution)**: 当某个 `JSONB` 扩展字段因业务增长需要参与高性能统计或建立 B-Tree 索引时，如何将其“物理化”为正式列而不丢失数据？

### 技术实现建议
- **动态转物理列**: 
    - 开发者需提供自动化脚本，将 `JSONB` 键值提取并回填到新物理列。
    - **逻辑**: `ALTER TABLE` 增加列 -> `UPDATE` 回填数据 -> 删除 `JSONB` 中对应键。
- **模式聚合**: 利用 PostgreSQL 的 **Views (视图)** 将标准表与 JSONB 扩展字段聚合展示。
- **示例代码**:
  ```sql
  -- 将 JSONB 字段提取到物理列
  ALTER TABLE sales_order ADD COLUMN custom_ref text;
  UPDATE sales_order SET custom_ref = ext_data->>'custom_ref';
  -- 随后清理 JSONB
  UPDATE sales_order SET ext_data = ext_data - 'custom_ref';
  ```

---

## 2. 插件化架构与报错回滚 (Plugin & Exception)

### 业务场景
- **逻辑切面**: “在不改源码的情况下介入业务逻辑”。
- **异常中断 (Abort & Rollback)**: 在 BE 插件（如 `BeforeSave`）中，如果逻辑不通过，如何统一返回错误信息给前端，并确保数据库事务回滚？

### 开发规范
- **异常捕获机制**: 
    - 插件内部必须通过 `RAISE EXCEPTION` 抛出特定格式的错误码。
    - UAP 框架必须捕获该异常，并将其映射为前端可读的 JSON 错误响应。
- **全生命周期钩子**: 支持 `BeforeSave`、`AfterSave` 等插件。

### 技术实现建议
- **数据库级强制回滚**: 插件代码应运行在主业务事务中。一旦插件抛出错误，整个 `SAVEPOINT` 或主事务自动回滚。
- **错误信息格式**: 建议使用 `SQLSTATE` 或 `JSON` 格式的错误堆栈。
- **示例代码**:
  ```sql
  -- 插件逻辑中的报错中断
  IF (NEW.qty > 1000) THEN
      RAISE EXCEPTION 'ERR_QTY_LIMIT: 数量不能超过 1000' 
      USING ERRCODE = 'P0001', DETAIL = 'Current Qty: ' || NEW.qty;
  END IF;
  ```

---

## 3. 多租户隔离与数据安全 (Security & Tenancy)

### 业务场景
“一套系统给多个子公司用，数据绝对不能串岗”。

### 开发规范
- **物理同库，逻辑隔离**: 同一个数据库实例内通过租户 ID 区分数据。
- **动态权限**: 权限控制应下沉到数据行级别。
- **技术实现建议**: 
    - **行级安全 (RLS)**: 利用 PostgreSQL 的 **Row Level Security**。在数据库层强制执行 `WHERE tenant_id = current_setting('app.current_tenant')`。即便开发者在 SQL 中忘记加租户过滤，数据库也会强制拦截，确保数据合规。
    - **会话上下文**: 通过 `set_config` 在数据库连接池获取连接时透传租户、用户等元数据。
    - **示例代码**:
      ```sql
      -- 开启 RLS 并配置租户隔离策略
      ALTER TABLE base_entity ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation_policy ON base_entity
      USING (tenant_id = current_setting('app.current_tenant')::int);
      ```

---

## 4. 并发控制与版本一致性 (Concurrency)

### 业务场景
“防止两个人在同一秒修改同一张订单”。

### 开发规范
- **乐观锁机制**: 实体必须包含版本标识。
- **死锁预防**: 复杂事务中必须遵循统一的锁定顺序。
- **技术实现建议**: 
    - **系统版本字段**: 利用 PostgreSQL 的隐藏系统列 `xmin` 或显式的 `version` 字段进行冲突检测。更新时执行 `WHERE id = :id AND version = :old_version`。
    - **语句级锁**: 在高并发更新场景下，利用 `FOR UPDATE OF` 仅锁定必要的行，减少索引页锁冲突。
    - **示例代码**:
      ```sql
      -- 使用 xmin 实现无感乐观锁
      UPDATE sales_order SET status = 'Approved' 
      WHERE id = :id AND xmin = :old_xmin;
      ```

## 5. 分布式事务与跨组织一致性 (Distributed Transactions)

### 业务场景
“跨组织调拨， A 组织扣减库存，B 组织必须增加库存”。在网络波动或组织间库区异构时，如何保证数据的一致性？

### 开发规范
- **两阶段提交 (2PC)**: 仅在金融级强一致性场景（如跨组织实时结算、资金拨付）中使用。
- **最终一致性 (TCC/Saga)**: 在供应链、库存等高并发场景下，推荐使用“本地事务 + 消息驱动 + 自动对冲”的方案。
- **技术实现建议**: 
    - **本地消息表**: 在主业务事务中同步写入“待处理任务表”，确保业务操作与任务记录原子性。
    - **自动对冲逻辑**: 如果下游（如 B 组织入库）失败且不可重试，必须自动触发上游（如 A 组织出库）的反向对冲（冲销）操作。
    - **幂等设计**: 所有跨组织接口必须支持 `request_id` 幂等校验。
    - **示例代码**:
      ```sql
      -- 本地事务内：扣减库存并插入外发任务
      BEGIN;
      UPDATE stock SET qty = qty - 10 WHERE org_id = 'A' AND item_id = :id;
      INSERT INTO outbox_tasks (task_type, payload, status) 
      VALUES ('CROSS_ORG_TRANSFER', :json_payload, 'Pending');
      COMMIT;
      
      -- 异步补偿/对冲示例
      IF (remote_call_failed) THEN
          -- 触发对冲：回退 A 组织库存
          INSERT INTO stock_journal (org_id, item_id, qty, direction) 
          VALUES ('A', :id, 10, 'In');
      END IF;
      ```

---

## 6. 开发者 Checklist

- [ ] **元数据一致性**: 动态扩展字段是否在元数据表中注册，并配置了相应的类型校验规则（JSON Schema）？
- [ ] **性能监控**: 插件执行时间是否记录在审计日志中？是否存在耗时过长的插件阻塞了主事务？
- [ ] **隔离性**: 是否在所有核心业务表上启用了 RLS，并经过了跨租户访问测试？
- [ ] **升级安全**: 二次开发是否严禁修改标准表的索引（可能导致升级 SQL 失败）？
- [ ] **多语言**: 扩展字段的描述信息是否已加入多语言资源包，并利用数据库函数实现动态翻译？
- [ ] **一致性策略**: 跨组织逻辑是选择了强一致性 (2PC) 还是最终一致性？是否实现了配套的自动对冲逻辑？
- [ ] **异常处理**: BE 插件是否通过 `RAISE EXCEPTION` 统一抛错，且错误码在全局字典中备案？
