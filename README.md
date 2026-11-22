# 提锂吸附柱换料的寿命分析与轮换决策

运行日自换料试运行起计；载荷采用归一处理量，采样缺失用问号。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

ratio 是相对于额定处理效果的比率。线路 units 中的柱串联且需同时可用，不同线路并联。备用柱同窗只替代一个已停用单元，不能增加原线路上限。建议中的风险上限按相应交货窗给出。

- `performance.json` 记录字段为 `column`、`load_lot`、`day`、`feed`、`processed`、`ratio`、`state`。
- `lab.json` 记录字段为 `column`、`day`、`revision`、`ratio`、`state`。
- `paths.json` 记录字段为 `line`、`units`、`capacity`、`backup`。
- `work.json` 记录字段为 `task`、`column`、`period`、`status`、`authority`。
- `delivery.json` 记录字段为 `window`、`min_qty`、`max_combined_risk`。
- `thresholds.json` 记录字段为 `feed`、`min_ratio`、`window_ready`。
- `maintenance.json` 记录字段为 `window`、`crew_slots`、`restart`。
- `product_rules.json` 记录字段为 `customer`、`grade`、`hold_allowed`、`latest`、`minimum`。
- `handoffs.json` 记录字段为 `piece`、`line`、`qty`、`col`、`window`、`condition`、`customer`。
- `storage.json` 记录字段为 `window`、`hold_volume`、`lab_slots`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
