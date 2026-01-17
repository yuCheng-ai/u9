# UAP 业务开发平台 (UAP Platform) - 开发者详尽指南

## 概述
UAP 是 U9 cloud 的“基因组”。在开发视角下，UAP 是一个**元数据驱动 (Metadata-Driven)** 的低代码与插件化框架。开发者应利用 PostgreSQL 的**动态模式支持**、**行级安全隔离**和**高并发版本控制**，在保证标准产品稳定的基础上，实现极高灵活性的二次开发。

---

## 1. 实体建模与动态扩展 (Modeling & Extensibility)

### 业务场景
“标准字段不够用，加个字段要动全身”。开发者需要一种既能快速扩展属性，又不破坏标准表结构的方案。

### 技术实现建议
    - **混合存储**: 物理表采用“固定列 + 扩展列”模式。固定列存放标准属性，扩展列使用 **JSONB** 存储个性化定制字段。
    - **模式聚合**: 利用 PostgreSQL 的 **Views (视图)** 将标准表与 JSONB 扩展字段聚合展示，提供给应用层透明的实体访问接口。
    - **示例代码**:
      ```sql
      -- 使用 JSONB 存储扩展属性并创建视图
      CREATE VIEW v_sales_order AS 
      SELECT *, 
             ext_data->>'custom_ref' as custom_ref,
             (ext_data->'is_urgent')::boolean as is_urgent
      FROM sales_order;
      ```

---

## 2. 插件化架构与切面钩子 (Plugin & AOP)

### 业务场景
“在不改源码的情况下，介入保存、删除等核心业务逻辑”。

### 开发规范
- **全生命周期钩子**: 支持 `BeforeSave`、`AfterSave`、`BeforeDelete` 等 BE 插件。
- **优先级驱动**: 多个插件按 `Priority` 顺序执行，支持中断逻辑。
- **技术实现建议**: 
    - **数据库钩子**: 复杂的跨系统校验可利用 PostgreSQL 的 **Triggers (触发器)** 作为最后一道防线。
    - **异步解耦**: 对于非实时性的插件逻辑（如发送通知），利用 **NOTIFY/LISTEN** 机制将逻辑从主事务中剥离，提升系统吞吐量。
    - **示例代码**:
      ```sql
      -- 使用 NOTIFY 异步触发插件逻辑
      CREATE TRIGGER trg_after_save AFTER INSERT OR UPDATE ON business_entity
      FOR EACH ROW EXECUTE FUNCTION notify_plugin_engine();
      -- 函数内执行: PERFORM pg_notify('plugin_event', NEW.id::text);
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

---

## 5. 开发者 Checklist

- [ ] **元数据一致性**: 动态扩展字段是否在元数据表中注册，并配置了相应的类型校验规则（JSON Schema）？
- [ ] **性能监控**: 插件执行时间是否记录在审计日志中？是否存在耗时过长的插件阻塞了主事务？
- [ ] **隔离性**: 是否在所有核心业务表上启用了 RLS，并经过了跨租户访问测试？
- [ ] **升级安全**: 二次开发是否严禁修改标准表的索引（可能导致升级 SQL 失败）？
- [ ] **多语言**: 扩展字段的描述信息是否已加入多语言资源包，并利用数据库函数实现动态翻译？
