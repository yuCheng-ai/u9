# 快速开始

本指南将帮助您快速搭建 U9 文档的本地开发环境并开始编写。

## 环境要求
- Node.js 18+ 
- npm 或 yarn

## 安装依赖
在项目根目录下执行：
```bash
npm install
```

## 启动本地预览
执行以下命令启动开发服务器：
```bash
npm run docs:dev
```
启动后，您可以在浏览器中访问 `http://localhost:5173` 查看文档。

## 编写文档
- `docs/`: 存放所有文档内容。
- `docs/modules/`: 存放 ERP 功能模块说明。
- `docs/guide/`: 存放产品架构与核心逻辑指南。
- 配置文件存放在 `docs/.vitepress/config.mts`，用于管理侧边栏和导航。
