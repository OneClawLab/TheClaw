# TheClaw 日常维护操作手册

给 Kiro 看的操作指南，执行时直接参考。

## 统一改版本号并提交

所有 repo 和子包的 package.json 版本号统一修改，然后逐个 git commit。

### 涉及的 package.json 文件

主 repo（9 个）：
```
pai/package.json
cmds/package.json
xdb/package.json
xweb/package.json
notifier/package.json
thread/package.json
xar/package.json
xgw/package.json
TheClaw/package.json
```

xgw 子包（3 个）：
```
xgw/clients/tui/package.json
xgw/plugins/feishu/package.json
xgw/plugins/tui/package.json
```

### 执行步骤

```bash
# 1. 改版本号（把 X.Y.Z 替换为目标版本）
for f in \
  pai/package.json \
  cmds/package.json \
  xdb/package.json \
  xweb/package.json \
  notifier/package.json \
  thread/package.json \
  xar/package.json \
  xgw/package.json \
  xgw/clients/tui/package.json \
  xgw/plugins/feishu/package.json \
  xgw/plugins/tui/package.json \
  TheClaw/package.json; do
  sed -i '0,/"version": "[^"]*"/s/"version": "[^"]*"/"version": "X.Y.Z"/' "$f"
done

# 2. 验证
for f in pai cmds xdb xweb notifier thread xar xgw TheClaw; do
  echo -n "$f: "; grep '"version"' $f/package.json | head -1
done
for f in xgw/clients/tui xgw/plugins/feishu xgw/plugins/tui; do
  echo -n "$f: "; grep '"version"' $f/package.json | head -1
done

# 3. 逐 repo 提交（只提交 package.json，不要 git add -A）
for repo in pai cmds xdb xweb notifier thread xar TheClaw; do
  (cd $repo && git add package.json && git commit -m "chore: bump version to X.Y.Z")
done
# xgw 单独处理（含子包）
(cd xgw && git add package.json clients/tui/package.json plugins/feishu/package.json plugins/tui/package.json && git commit -m "chore: bump version to X.Y.Z")
```

### 注意事项

- **绝对不要用 `git add -A`**，会把 tmp/、dist/ 等垃圾带进去
- 只 `git add` 明确的 package.json 文件
- xgw repo 包含 3 个子包，需要一起 add 再 commit
- 工作目录在所有 repo 的父目录（如 `/c/TheClaw/`）
