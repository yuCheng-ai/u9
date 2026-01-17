# UAP 业务开发平台 (UAP Platform) - 开发者详尽指南

## 概述
UAP 是 U9 cloud 的“基因组”。开发者必须理解：在 UAP 上开发不是在写孤立的代码，而是在**操作元数据 (Metadata)**。UAP 通过高度抽象的模型，实现了“逻辑与展现分离、代码与升级解耦”。

---

## 1. 实体建模与元数据驱动 (Metadata-Driven Modeling)

### 企业痛点
**“加一个字段要改数据库表、改 POJO 类、改 SQL、改界面，改 10 个地方，漏一个就报错”**。

### 开发逻辑点
- **实体设计器 (Entity Designer)**: 
    - 开发者只需在 UAP 建模工具中添加属性。
    - **逻辑**: UAP 自动生成物理表结构、C# 实体类、以及 O/RM 映射元数据。
- **关联模型 (Relationship)**: 
    - 开发者需正确配置 `Association` (关联) 和 `Composition` (聚合)。
    - **开发注意**: 聚合关系（如订单头与订单行）由 UAP 自动管理级联保存和删除，开发者无需手写 `DELETE` 语句。

---

## 2. 插件化架构与切面编程 (Plugin & AOP)

### 企业痛点
“我想在保存订单前加一个校验，但我没法改标准产品的源码”。

### 开发逻辑点
- **BE 插件 (Business Entity Plugin)**: 
    - 开发者通过继承 `IPlugin` 接口，在 `BeforeSave`、`AfterSave` 等钩子函数中植入代码。
    - **逻辑**: `Plugin_Registry` 会在运行时自动扫描并按 `Priority` 顺序调用这些插件。
- **UI 插件**: 
    - 开发者可在界面加载 (`OnLoad`) 或按钮点击 (`OnClick`) 时注入逻辑，动态隐藏字段或改变控件颜色。

---

## 3. 工作流引擎与状态机 (Workflow & State Machine)

### 企业痛点
**“公司的审批流程天天变，昨天是经理审，今天是总监审，还得按金额跳步”**。

### 开发逻辑点
- **图形化流程定义**: 
    - 开发者需配置 `Workflow_Node` 和 `Condition_Branch`。
    - **逻辑**: `IF (Order.Amount > 100000) THEN Route_to_VP ELSE Route_to_Manager`。
- **动作绑定 (Action Binding)**: 
    - 流程节点可以绑定 BE 动作。例如：流程结束（End）时，自动触发“库存扣减”或“凭证生成”。

---

## 4. 动态扩展与热部署 (Extensibility)

### 企业痛点
“系统升级后，我之前做的二次开发全被覆盖了，又得重写”。

### 开发逻辑点
- **个性化元数据**: 
    - 所有的定制信息都存储在 `Personalization` 表中，而非修改标准库。
    - **逻辑**: 运行时 UAP 会将标准元数据与个性化元数据进行 `Merge`。
- **热补丁 (Hotfix)**: 
    - UAP 支持 DLL 的动态加载。开发者上传插件后，无需重启 IIS 即可立即生效。

---

## 5. 开发者 Checklist

- [ ] **性能**: 实体查询时，严禁使用 `SELECT *`，必须通过 `View` 或 `AttributeSelection` 指定需要的字段。
- [ ] **多语言**: 所有的字段显示名称（DisplayName）必须录入到 `Resource_Center`，严禁在代码中写死中文。
- [ ] **异常处理**: 插件内部的异常必须使用 `BusinessException` 抛出，以便 UAP 前端能正确捕获并弹出友好的提示框。
- [ ] **并发冲突**: 在高并发场景下，开发者必须在实体上开启 `Timestamp` (时间戳) 校验，防止丢失更新（Lost Update）。
- [ ] **升级兼容性**: 开发者严禁修改标准数据库表的索引或约束，只能通过 UAP 工具进行扩展。
