# 贡献指南

## 分支与提交

- `main` 保护，功能分支 `feat/T08-rca`
- 一卡一 PR（自己 merge 也可以，保留 PR 记录）
- Conventional Commits：

```
feat(topology): 拓扑画布支持拖拽布局
fix(correlation): 修复跨日时间窗聚合漏簇
docs(framework): 补充证据校验器说明
test(rca): 增加校验器丢弃逻辑用例
```

## 提交前

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

## 代码约定

- 单文件 ≤ 300 行；`page.tsx` ≤ 120 行
- 颜色只用 `globals.css` 的 CSS 变量；图标只用 `lucide-react`
- 禁止 `any`、`console.log`、硬编码密钥
- 业务规则写在 `src/modules/*/service.ts`，不写在 route 或组件里
