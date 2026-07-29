const api = window.aruHost;
const locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const copy = {
  zh: {
    subtitle: "让电脑上的协作者持续在场", preparing: "正在准备 Aru Host", preparingDetail: "第一次打开会安装同版本后台服务，已有数据和回滚记录会原样保留。",
    overview: "总览", backups: "备份仓", mcp: "MCP", plugins: "插件", workspaces: "电脑文件夹", runtime: "运行环境", artifacts: "产物仓", collaborators: "电脑协作者",
    hostRunning: "Host Core 正在运行", refresh: "重新读取", retry: "重试", close: "关闭", cancel: "取消", confirm: "确认", save: "保存", create: "创建", delete: "删除", download: "下载", edit: "编辑", test: "测试", open: "打开",
    overviewTitle: "这台电脑的 Host", overviewDetail: "后台服务持有协作者、工具、工作与备份；关闭这个窗口不会让它离线。", systemHealthy: "服务可用", secureStorage: "凭据由 Linux Secret Service 保护", mobilePair: "连接手机", rename: "修改名称", pairedDevices: "已连接设备", capabilities: "能力状态", noDevices: "还没有其他设备", noDevicesDetail: "生成一次配对码，让手机确认这台电脑。",
    packages: "备份包", retention: "保留规则", keepAll: "全部保留", keepLatest: "只保留最近几份", noBackups: "备份仓还是空的", noBackupsDetail: "手机上传的加密备份会在这里出现，Host 不会解密其中内容。", latestCount: "保留份数",
    mcpTitle: "模型可使用的动作", mcpDetail: "这里展示当前 Host 真实发布的工具与输入约束，没有静态占位目录。", noTools: "当前没有可用工具", inputSchema: "输入结构",
    pluginsTitle: "独立插件", pluginsDetail: "插件拥有自己的权限、运行状态、版本与回滚，不会混进 Host Core。", newPlugin: "新建源码插件", noPlugins: "还没有安装插件", noPluginsDetail: "可以从一段受限 Node.js 源码开始，先验证权限再直接安装。", enable: "启用", disable: "停用", rollback: "回滚", uninstall: "卸载", retainData: "保留插件数据", sourceCode: "源码", pluginId: "插件标识", displayName: "显示名称", version: "版本", capabilityNames: "能力名称，用逗号分隔", applyPlugin: "验证并安装",
    foldersTitle: "电脑文件夹", foldersDetail: "Host 只进入你明确交给它的文件夹；默认工作区由 Host 持有，不能误删。", addFolder: "添加文件夹", noFolders: "没有可用文件夹", revoke: "移除授权",
    runtimeTitle: "工作运行", runtimeDetail: "隔离任务、资源限制和失败状态都来自 Host 的真实作业账本。", defaultTimeout: "默认最长运行秒数", unlimited: "不设固定上限", jobs: "最近作业", noJobs: "还没有运行过工作", cancelJob: "停止", retryJob: "重试",
    artifactsTitle: "工作产物", artifactsDetail: "二进制结果由 Host 按哈希保存，下载和删除都走明确动作。", noArtifacts: "还没有产物", noArtifactsDetail: "隔离工作发布的文件会在这里出现。",
    collaboratorsTitle: "电脑协作者", collaboratorsDetail: "每位协作者拥有自己的 Host 对话、认知、页面和工具准入，驱动只是执行出口。", newCollaborator: "创建协作者", providerRoutes: "模型路线", newProvider: "添加模型路线", noCollaborators: "还没有电脑协作者", noCollaboratorsDetail: "选择一个已就绪的驱动，建立第一位由这台电脑持续承载的协作者。", driver: "驱动", provider: "模型路线", studio: "进入工作台", refreshDrivers: "重新探测驱动",
    providerProtocol: "协议", baseURL: "基础地址", requestPath: "请求路径", model: "模型", apiKey: "API 密钥", authMode: "鉴权方式", maxOutput: "最大输出 token，可留空", maxRounds: "最大工具轮数，可留空", routeReady: "可用", routeUnavailable: "不可用",
    conversations: "对话", surfaces: "页面", cognition: "认知", initiative: "主动约定", newInitiative: "新建主动约定", initiativeTitle: "标题", initiativeGoal: "他到时候想主动做什么", initiativeInstructions: "语气、背景或判断说明", initiativeWhen: "首次触发", initiativeRepeat: "重复", initiativeOnce: "仅一次", initiativeHourly: "每小时", initiativeDaily: "每天", initiativeWeekly: "每周", initiativeNotify: "完成后通知已连接手机", initiativeRunNow: "现在运行", initiativePause: "暂停", initiativeResume: "继续", noInitiative: "还没有主动约定", initiativeHostOwned: "规则由 Host Core 持续执行，关闭窗口不会停止。", initiativeDeliveries: "已完成 {count} 次", projects: "页面项目", newProject: "新建页面项目", projectTitle: "项目名称", projectGitHub: "GitHub 仓库链接，可留空", projectEntry: "手机展示入口", projectHostOwned: "一个 Host 工作区、一份 Git 状态；保存进入产物，发布才更新手机。", noProjects: "还没有页面项目", projectSave: "保存进产物", projectPublish: "发布到手机", projectNote: "本次说明", projectNetwork: "手机页面联网", projectDirty: "有未提交改动", projectPublished: "已连接手机", projectUnpublished: "尚未发布", projectCheckpoints: "{count} 个检查点", newConversation: "新对话", conversationTitle: "对话标题，可留空", send: "发送", approve: "允许", deny: "拒绝", stop: "停止生成", noConversations: "还没有对话", newSurface: "新页面", surfaceTitle: "页面标题", htmlSource: "完整 HTML", note: "版本说明", networkAccess: "网络访问", networkNone: "关闭", networkOutbound: "允许出站", noSurfaces: "还没有页面", systemPrompt: "系统指令", instructionEnvironment: "指令环境", isolated: "独立", inheritCodex: "继承电脑 Codex 环境", memories: "记忆", references: "参考资料", noCognitionRecords: "这里还没有记录",
    updateAvailable: "可更新到 {version}", updateAction: "下载更新", updateHint: "会交给系统的软件安装器，Host 数据留在原目录。", operationDone: "已完成", destructiveTitle: "确认这个动作", failureTitle: "这里没有成功完成", repair: "修复安全连接", chooseFolder: "选择文件夹", name: "名称", status: "状态", size: "大小", updated: "更新于", unknown: "未知",
    settings: "设置", toolAccess: "工具准入", allTools: "允许当前和未来全部工具", selectedTools: "只允许指定工具", toolNames: "工具名称，用逗号分隔", approveSession: "本次运行允许", archive: "归档", restore: "恢复", editSurface: "编辑页面", rollbackVersion: "回滚版本", newMemory: "添加记忆", newReference: "添加参考资料", recordTitle: "标题", recordContent: "内容", bundleEditUnavailable: "工程页面请回到它的电脑工作区编辑", consoleVersionNote: "由 Linux Console 发布", consoleRollbackNote: "由 Linux Console 回滚", uninstallHost: "移除这台电脑的 Host", uninstallHostDetail: "停止并移除当前用户的后台服务和设置，协作者、对话、页面与其他数据仍保留。", hostRemoved: "Host 已从当前用户移除，数据仍然保留。现在可以关闭窗口并卸载系统里的 Aru Host 应用。", enabled: "已启用", disabled: "未启用", thisConsole: "当前 Console",
  },
  en: {
    subtitle: "Keep your computer-hosted collaborators present", preparing: "Preparing Aru Host", preparingDetail: "First launch installs the matching background service while preserving existing data and rollback history.",
    overview: "Overview", backups: "Backup Vault", mcp: "MCP", plugins: "Plugins", workspaces: "Computer Folders", runtime: "Runtime", artifacts: "Artifacts", collaborators: "Computer Collaborators",
    hostRunning: "Host Core is running", refresh: "Refresh", retry: "Retry", close: "Close", cancel: "Cancel", confirm: "Confirm", save: "Save", create: "Create", delete: "Delete", download: "Download", edit: "Edit", test: "Test", open: "Open",
    overviewTitle: "This computer's Host", overviewDetail: "The background service owns collaborators, tools, work, and backups. Closing this window does not take it offline.", systemHealthy: "Service available", secureStorage: "Credentials protected by Linux Secret Service", mobilePair: "Connect phone", rename: "Rename", pairedDevices: "Connected devices", capabilities: "Capabilities", noDevices: "No other devices yet", noDevicesDetail: "Issue a pairing code and confirm this computer from your phone.",
    packages: "Backup packages", retention: "Retention", keepAll: "Keep all", keepLatest: "Keep latest", noBackups: "The vault is empty", noBackupsDetail: "Encrypted phone backups appear here. Host never decrypts their contents.", latestCount: "Packages to keep",
    mcpTitle: "Model actions", mcpDetail: "The live tools and input contracts published by this Host, without a static placeholder catalog.", noTools: "No tools are available", inputSchema: "Input schema",
    pluginsTitle: "Independent plugins", pluginsDetail: "Each plugin owns permissions, runtime state, versions, and rollback without merging into Host Core.", newPlugin: "New source plugin", noPlugins: "No plugins installed", noPluginsDetail: "Start with constrained Node.js source, validate its permissions, then install it directly.", enable: "Enable", disable: "Disable", rollback: "Rollback", uninstall: "Uninstall", retainData: "Keep plugin data", sourceCode: "Source", pluginId: "Plugin id", displayName: "Display name", version: "Version", capabilityNames: "Capabilities, comma separated", applyPlugin: "Validate and install",
    foldersTitle: "Computer folders", foldersDetail: "Host enters only folders you explicitly grant. The managed default cannot be revoked by mistake.", addFolder: "Add folder", noFolders: "No folders available", revoke: "Remove grant",
    runtimeTitle: "Work runtime", runtimeDetail: "Isolated jobs, resource limits, and failures come from the durable Host job ledger.", defaultTimeout: "Default maximum seconds", unlimited: "No fixed limit", jobs: "Recent jobs", noJobs: "No work has run yet", cancelJob: "Stop", retryJob: "Retry",
    artifactsTitle: "Work artifacts", artifactsDetail: "Host stores binary results by hash. Download and deletion remain explicit actions.", noArtifacts: "No artifacts yet", noArtifactsDetail: "Files published by isolated work appear here.",
    collaboratorsTitle: "Computer collaborators", collaboratorsDetail: "Each collaborator owns Host conversations, cognition, pages, and tool admission. Drivers are execution outlets only.", newCollaborator: "Create collaborator", providerRoutes: "Model routes", newProvider: "Add model route", noCollaborators: "No computer collaborators", noCollaboratorsDetail: "Choose a ready driver and create the first collaborator continuously hosted by this computer.", driver: "Driver", provider: "Model route", studio: "Open studio", refreshDrivers: "Refresh drivers",
    providerProtocol: "Protocol", baseURL: "Base URL", requestPath: "Request path", model: "Model", apiKey: "API key", authMode: "Authentication", maxOutput: "Maximum output tokens, optional", maxRounds: "Maximum tool rounds, optional", routeReady: "Ready", routeUnavailable: "Unavailable",
    conversations: "Conversations", surfaces: "Pages", cognition: "Cognition", initiative: "Initiative", newInitiative: "New proactive plan", initiativeTitle: "Title", initiativeGoal: "What should they proactively do?", initiativeInstructions: "Tone, context, or judgment guidance", initiativeWhen: "First run", initiativeRepeat: "Repeat", initiativeOnce: "Once", initiativeHourly: "Hourly", initiativeDaily: "Daily", initiativeWeekly: "Weekly", initiativeNotify: "Notify connected phones when complete", initiativeRunNow: "Run now", initiativePause: "Pause", initiativeResume: "Resume", noInitiative: "No proactive plans yet", initiativeHostOwned: "Host Core keeps schedules running after this window closes.", initiativeDeliveries: "{count} completed", projects: "Page projects", newProject: "New page project", projectTitle: "Project name", projectGitHub: "GitHub repository URL, optional", projectEntry: "Phone entry point", projectHostOwned: "One Host workspace and one Git state. Save creates an artifact; Publish updates the phone.", noProjects: "No page projects yet", projectSave: "Save to artifacts", projectPublish: "Publish to phone", projectNote: "Checkpoint note", projectNetwork: "Phone surface network", projectDirty: "Uncommitted changes", projectPublished: "Connected to phone", projectUnpublished: "Not published", projectCheckpoints: "{count} checkpoints", newConversation: "New conversation", conversationTitle: "Conversation title, optional", send: "Send", approve: "Allow", deny: "Deny", stop: "Stop", noConversations: "No conversations yet", newSurface: "New page", surfaceTitle: "Page title", htmlSource: "Complete HTML", note: "Version note", networkAccess: "Network access", networkNone: "Off", networkOutbound: "Outbound", noSurfaces: "No pages yet", systemPrompt: "System instruction", instructionEnvironment: "Instruction environment", isolated: "Independent", inheritCodex: "Inherit computer Codex environment", memories: "Memories", references: "References", noCognitionRecords: "No records here yet",
    updateAvailable: "Update to {version}", updateAction: "Download update", updateHint: "Your system installer handles the package and Host data remains in place.", operationDone: "Done", destructiveTitle: "Confirm this action", failureTitle: "This did not complete", repair: "Repair secure connection", chooseFolder: "Choose folder", name: "Name", status: "Status", size: "Size", updated: "Updated", unknown: "Unknown",
    settings: "Settings", toolAccess: "Tool access", allTools: "Allow all current and future tools", selectedTools: "Allow selected tools only", toolNames: "Tool names, comma separated", approveSession: "Allow for this run", archive: "Archive", restore: "Restore", editSurface: "Edit page", rollbackVersion: "Rollback version", newMemory: "Add memory", newReference: "Add reference", recordTitle: "Title", recordContent: "Content", bundleEditUnavailable: "Edit project pages in their computer workspace", consoleVersionNote: "Published from Linux Console", consoleRollbackNote: "Rolled back from Linux Console", uninstallHost: "Remove this computer's Host", uninstallHostDetail: "Stop and remove this user's background service and settings while preserving collaborators, conversations, pages, and other data.", hostRemoved: "Host was removed from this user and its data was preserved. You can now close this window and uninstall the Aru Host system package.", enabled: "Enabled", disabled: "Disabled", thisConsole: "This Console",
  },
};
const t = (key, values = {}) => Object.entries(values).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), copy[locale][key] ?? copy.en[key] ?? key);
const sections = [
  ["overview", "⌂"], ["backups", "◈"], ["mcp", "⌘"], ["plugins", "◇"],
  ["workspaces", "▱"], ["runtime", "⌁"], ["artifacts", "▰"], ["collaborators", "◌"],
];
const state = { section: "overview", bootstrap: null, data: {}, busy: false, update: null };
const content = document.querySelector("#content");
const activity = document.querySelector("#activity");
const navigation = document.querySelector("#navigation");
const dialog = document.querySelector("#action-dialog");
const toast = document.querySelector("#toast");

document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
document.querySelector("#app-subtitle").textContent = t("subtitle");
document.querySelector("#dialog-cancel").textContent = t("cancel");
document.querySelector("#dialog-confirm").textContent = t("confirm");
document.querySelector("#update-button").addEventListener("click", () => state.update && api.openUpdate(state.update.url));
renderPreparing();
boot();

async function boot() {
  setBusy(true);
  try {
    state.bootstrap = await api.bootstrap();
    state.update = state.bootstrap.update;
    document.querySelector("#node-name").textContent = state.bootstrap.nodeSettings.displayName;
    renderNavigation();
    renderUpdate();
    await selectSection("overview");
  } catch (error) { renderFailure(error); }
  finally { setBusy(false); }
}

function renderPreparing() {
  content.innerHTML = `<div class="loading-state"><div><div class="loading-light"></div><h2>${esc(t("preparing"))}</h2><p>${esc(t("preparingDetail"))}</p></div></div>`;
}

function renderNavigation() {
  navigation.setAttribute("aria-label", t("subtitle"));
  navigation.innerHTML = sections.map(([key, glyph]) => `<button class="nav-button ${state.section === key ? "active" : ""}" data-section="${key}"><span class="nav-glyph">${glyph}</span><span class="nav-label">${esc(t(key))}</span><span class="nav-badge" data-badge="${key}"></span></button>`).join("")
    + `<div class="nav-footer"><div><span class="service-dot"></span>${esc(t("hostRunning"))}</div><div>${esc(state.bootstrap?.manifest?.serverVersion ?? "")}</div></div>`;
  navigation.querySelectorAll("[data-section]").forEach((button) => button.addEventListener("click", () => selectSection(button.dataset.section)));
  updateBadges();
}

async function selectSection(section) {
  state.section = section;
  renderNavigation();
  setBusy(true);
  content.innerHTML = `<div class="loading-state"><div class="loading-light"></div></div>`;
  try {
    if (section === "overview") await renderOverview();
    if (section === "backups") await renderBackups();
    if (section === "mcp") await renderMCP();
    if (section === "plugins") await renderPlugins();
    if (section === "workspaces") await renderWorkspaces();
    if (section === "runtime") await renderRuntime();
    if (section === "artifacts") await renderArtifacts();
    if (section === "collaborators") await renderCollaborators();
    content.focus();
  } catch (error) { renderSectionFailure(error); }
  finally { setBusy(false); updateBadges(); }
}

async function renderOverview() {
  const [diagnostics, settings, devices] = await Promise.all([
    api.request("GET", "/aru/v1/diagnostics"), api.request("GET", "/aru/v1/node-settings"), api.request("GET", "/aru/v1/devices"),
  ]);
  state.data.overview = { diagnostics, settings, devices };
  const activeDevices = devices.devices.filter((device) => !device.revokedAt);
  content.innerHTML = pageHead("overview", t("overviewTitle"), t("overviewDetail"), `<button class="quiet-button" data-action="rename">${esc(t("rename"))}</button><button class="primary-button" data-action="pair">${esc(t("mobilePair"))}</button>`)
    + `<section class="hero"><p class="eyebrow">Aru Host Core</p><h3>${esc(settings.displayName)}</h3><p>${esc(diagnostics.serverVersion)} · ${esc(diagnostics.serverId)}</p><div class="status-row"><span class="status-pill good">${esc(t("systemHealthy"))}</span><span class="status-pill good">${esc(t("secureStorage"))}</span></div></section>`
    + `<div class="metrics">${metric(diagnostics.hostedCollaboratorCount, t("collaborators"))}${metric(diagnostics.activeJobCount, t("runtime"))}${metric(diagnostics.artifactCount, t("artifacts"))}${metric(activeDevices.length, t("pairedDevices"))}</div>`
    + sectionBlock(t("capabilities"), "", `<div class="raised-list">${diagnostics.capabilities.map((capability) => row(capability.id, capability.enabled ? t("systemHealthy") : t("routeUnavailable"), `<span class="status-pill ${capability.enabled ? "good" : "warn"}">${esc(t(capability.enabled ? "enabled" : "disabled"))}</span>`)).join("")}</div>`)
    + sectionBlock(t("pairedDevices"), "", activeDevices.length ? `<div class="raised-list">${activeDevices.map((device) => row(device.label, formatDate(device.issuedAt), device.isCurrent ? `<span class="tag">${esc(t("thisConsole"))}</span>` : `<button class="danger-button" data-revoke="${escAttr(device.deviceId)}">${esc(t("revoke"))}</button>`)).join("")}</div>` : empty("◌", t("noDevices"), t("noDevicesDetail")))
    + sectionBlock(t("settings"), t("uninstallHostDetail"), `<button class="danger-button" data-uninstall-host>${esc(t("uninstallHost"))}</button>`);
  content.querySelector("[data-action=rename]").addEventListener("click", async () => {
    const values = await openForm(t("rename"), [{ name: "displayName", label: t("displayName"), value: settings.displayName, required: true }]);
    if (!values) return;
    await mutate(() => api.request("PUT", "/aru/v1/node-settings", { schema: "aru.selfhost.node-settings.v1", displayName: values.displayName, expectedRevision: settings.revision }), "overview");
  });
  content.querySelector("[data-action=pair]").addEventListener("click", showMobilePairing);
  content.querySelectorAll("[data-revoke]").forEach((button) => button.addEventListener("click", async () => {
    if (!await confirmDialog(t("revoke"), t("destructiveTitle"), true)) return;
    await mutate(() => api.request("POST", "/aru/v1/devices/revoke", { deviceId: button.dataset.revoke }), "overview");
  }));
  content.querySelector("[data-uninstall-host]").addEventListener("click", async () => {
    if (!await confirmDialog(t("uninstallHost"), t("uninstallHostDetail"), true)) return;
    setBusy(true);
    try {
      await api.uninstallHost();
      navigation.innerHTML = "";
      content.innerHTML = `<div class="failure-state"><div><div class="empty-symbol">✓</div><h2>${esc(t("uninstallHost"))}</h2><p>${esc(t("hostRemoved"))}</p></div></div>`;
    } catch (error) { showToast(error.message, true); }
    finally { setBusy(false); }
  });
}

async function showMobilePairing() {
  setBusy(true);
  try {
    const link = await api.issueMobilePairing();
    const qr = await api.qr(link);
    await messageDialog(t("mobilePair"), `<div class="empty"><img src="${qr}" alt="QR" width="260" height="260"><p class="source-view">${esc(link)}</p></div>`);
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(false); }
}

async function renderBackups() {
  const [inventory, settings] = await Promise.all([api.request("GET", "/aru/v1/backups"), api.request("GET", "/aru/v1/backups/settings")]);
  state.data.backups = inventory.packages;
  content.innerHTML = pageHead("backups", t("backups"), t("noBackupsDetail"), `<button class="quiet-button" data-retention>${esc(t("retention"))}</button>`)
    + sectionBlock(t("retention"), settings.retentionMode === "keep-all" ? t("keepAll") : `${t("keepLatest")} · ${settings.keepLatestCount}`, "")
    + (inventory.packages.length ? `<div class="raised-list">${inventory.packages.map((item) => row(item.metadata.sourceName, `${formatBytes(item.metadata.packageByteCount)} · ${formatDate(item.uploadedAt)}`, `<button class="quiet-button" data-download="${escAttr(item.remotePackageId)}">${esc(t("download"))}</button><button class="danger-button" data-delete="${escAttr(item.remotePackageId)}">${esc(t("delete"))}</button>`)).join("")}</div>` : empty("◈", t("noBackups"), t("noBackupsDetail")));
  content.querySelector("[data-retention]").addEventListener("click", async () => {
    const values = await openForm(t("retention"), [
      { name: "mode", label: t("retention"), type: "select", value: settings.retentionMode, options: [["keep-all", t("keepAll")], ["keep-latest", t("keepLatest")]] },
      { name: "count", label: t("latestCount"), type: "number", value: settings.keepLatestCount ?? 5 },
    ]);
    if (!values) return;
    await mutate(() => api.request("PUT", "/aru/v1/backups/settings", { schema: "aru.selfhost.backup-settings.v1", retentionMode: values.mode, keepLatestCount: values.mode === "keep-latest" ? Number(values.count) : null, expectedRevision: settings.revision }), "backups");
  });
  bindDownloads("backups", inventory.packages, (item) => item.remotePackageId, (item) => item.metadata.sourceName || `${item.remotePackageId}.aru-backup`);
}

async function renderMCP() {
  const catalog = await api.mcpCatalog(); state.data.mcp = catalog.tools;
  content.innerHTML = pageHead("mcp", t("mcpTitle"), t("mcpDetail")) + (catalog.tools.length ? `<div class="raised-list">${catalog.tools.map((tool) => `<article class="list-row"><div class="row-main"><div class="row-title">${esc(tool.title ?? tool.name)}</div><div class="row-detail">${esc(tool.description ?? tool.name)}</div><details><summary>${esc(t("inputSchema"))}</summary><pre class="tool-schema">${esc(JSON.stringify(tool.inputSchema, null, 2))}</pre></details></div><span class="tag">${esc(tool.name)}</span></article>`).join("")}</div>` : empty("⌘", t("noTools"), t("mcpDetail")));
}

async function renderPlugins() {
  const [inventory, drafts] = await Promise.all([api.request("GET", "/aru/v1/plugins"), api.request("GET", "/aru/v1/plugin-workshop/drafts")]);
  state.data.plugins = inventory.plugins;
  content.innerHTML = pageHead("plugins", t("pluginsTitle"), t("pluginsDetail"), `<button class="primary-button" data-new-plugin>${esc(t("newPlugin"))}</button>`)
    + (inventory.plugins.length ? `<div class="raised-list">${inventory.plugins.map((plugin) => row(plugin.manifest.displayName, `${plugin.manifest.version} · ${plugin.health}${plugin.lastErrorMessage ? ` · ${plugin.lastErrorMessage}` : ""}`, `${plugin.manifest.packageMode === "source-node" ? `<button class="quiet-button" data-edit-plugin="${escAttr(plugin.pluginId)}">${esc(t("edit"))}</button>` : ""}<button class="quiet-button" data-plugin-action="${plugin.desiredState === "enabled" ? "disable" : "enable"}" data-plugin="${escAttr(plugin.pluginId)}">${esc(t(plugin.desiredState === "enabled" ? "disable" : "enable"))}</button>${plugin.rollbackAvailable ? `<button class="quiet-button" data-plugin-action="rollback" data-plugin="${escAttr(plugin.pluginId)}">${esc(t("rollback"))}</button>` : ""}<button class="danger-button" data-plugin-action="uninstall" data-plugin="${escAttr(plugin.pluginId)}">${esc(t("uninstall"))}</button>`)).join("")}</div>` : empty("◇", t("noPlugins"), t("noPluginsDetail")))
    + (drafts.drafts.length ? sectionBlock(t("sourceCode"), "", `<div class="raised-list">${drafts.drafts.map((draft) => row(draft.displayName, `${draft.version} · ${draft.target}`, `<button class="primary-button" data-apply-draft="${escAttr(draft.pluginId)}">${esc(t("applyPlugin"))}</button>`)).join("")}</div>`) : "");
  content.querySelector("[data-new-plugin]").addEventListener("click", createPlugin);
  content.querySelectorAll("[data-edit-plugin]").forEach((button) => button.addEventListener("click", () => editPlugin(button.dataset.editPlugin)));
  content.querySelectorAll("[data-plugin-action]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.pluginAction; const id = encodeURIComponent(button.dataset.plugin);
    if (action === "uninstall") {
      if (!await confirmDialog(t("uninstall"), t("destructiveTitle"), true)) return;
      await mutate(() => api.request("DELETE", `/aru/v1/plugins/${id}?deleteData=false`), "plugins");
    } else await mutate(() => api.request("POST", `/aru/v1/plugins/${id}/${action}`), "plugins");
  }));
  content.querySelectorAll("[data-apply-draft]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/plugin-workshop/drafts/${encodeURIComponent(button.dataset.applyDraft)}/apply`), "plugins")));
}

async function createPlugin() {
  await editPlugin(null);
}

async function editPlugin(pluginId) {
  const source = pluginId ? await api.request("GET", `/aru/v1/plugins/${encodeURIComponent(pluginId)}/source`) : null;
  const values = await openForm(source ? t("edit") : t("newPlugin"), [
    { name: "pluginId", label: t("pluginId"), value: source?.pluginId ?? "", required: true, disabled: Boolean(source) },
    { name: "displayName", label: t("displayName"), value: source?.displayName ?? "", required: true },
    { name: "version", label: t("version"), value: source?.version ?? "0.1.0", required: true },
    { name: "capabilities", label: t("capabilityNames"), value: source?.capabilities?.join(", ") ?? "" },
    { name: "sourceCode", label: t("sourceCode"), type: "textarea", value: source?.sourceCode ?? "export default {\n  tools: [],\n};", required: true },
  ], t("applyPlugin"));
  if (!values) return;
  const body = { pluginId: source?.pluginId ?? values.pluginId, displayName: values.displayName, version: values.version, sourceCode: values.sourceCode, capabilities: values.capabilities.split(",").map((value) => value.trim()).filter(Boolean) };
  await mutate(async () => { await api.request("POST", "/aru/v1/plugin-workshop/validate", body); return api.request("POST", "/aru/v1/plugin-workshop/apply", body); }, "plugins");
}

async function renderWorkspaces() {
  const inventory = await api.request("GET", "/aru/v1/node-workspaces"); state.data.workspaces = inventory.workspaces;
  content.innerHTML = pageHead("workspaces", t("foldersTitle"), t("foldersDetail"), `<button class="primary-button" data-add-folder>${esc(t("addFolder"))}</button>`)
    + (inventory.workspaces.length ? `<div class="raised-list">${inventory.workspaces.map((workspace) => row(workspace.displayName, `${workspace.rootDisplayPath} · ${workspace.permissions.join(", ")}`, workspace.isDefault ? `<span class="tag">Host</span>` : `<button class="danger-button" data-revoke-folder="${escAttr(workspace.workspaceId)}">${esc(t("revoke"))}</button>`)).join("")}</div>` : empty("▱", t("noFolders"), t("foldersDetail")));
  content.querySelector("[data-add-folder]").addEventListener("click", async () => {
    const rootPath = await api.chooseFolder(); if (!rootPath) return;
    const values = await openForm(t("addFolder"), [{ name: "displayName", label: t("displayName"), value: rootPath.split("/").pop(), required: true }]);
    if (!values) return;
    await mutate(() => api.request("POST", "/aru/v1/node-workspaces", { rootPath, displayName: values.displayName }), "workspaces");
  });
  content.querySelectorAll("[data-revoke-folder]").forEach((button) => button.addEventListener("click", async () => {
    if (!await confirmDialog(t("revoke"), t("destructiveTitle"), true)) return;
    await mutate(() => api.request("DELETE", `/aru/v1/node-workspaces/${encodeURIComponent(button.dataset.revokeFolder)}`), "workspaces");
  }));
}

async function renderRuntime() {
  const [inventory, policy] = await Promise.all([api.request("GET", "/aru/v1/jobs"), api.request("GET", "/aru/v1/jobs/policy")]); state.data.runtime = inventory.jobs;
  content.innerHTML = pageHead("runtime", t("runtimeTitle"), t("runtimeDetail"), `<button class="quiet-button" data-policy>${esc(t("defaultTimeout"))}</button>`)
    + `<section class="hero"><p class="eyebrow">${esc(t("defaultTimeout"))}</p><h3>${policy.defaultMaximumRuntimeSeconds ?? t("unlimited")}</h3></section>`
    + sectionBlock(t("jobs"), "", inventory.jobs.length ? `<div class="raised-list">${inventory.jobs.map((job) => row(job.projectId, `${job.runtime} · ${job.state}${job.failureMessage ? ` · ${job.failureMessage}` : ""}`, `${["queued", "running"].includes(job.state) ? `<button class="danger-button" data-job="${escAttr(job.jobId)}" data-job-action="cancel">${esc(t("cancelJob"))}</button>` : ""}${["failed", "cancelled"].includes(job.state) ? `<button class="quiet-button" data-job="${escAttr(job.jobId)}" data-job-action="retry">${esc(t("retryJob"))}</button>` : ""}`)).join("")}</div>` : empty("⌁", t("noJobs"), t("runtimeDetail")));
  content.querySelector("[data-policy]").addEventListener("click", async () => {
    const values = await openForm(t("defaultTimeout"), [{ name: "seconds", label: t("defaultTimeout"), type: "number", value: policy.defaultMaximumRuntimeSeconds ?? "", hint: t("unlimited") }]);
    if (!values) return;
    await mutate(() => api.request("PUT", "/aru/v1/jobs/policy", { schema: "aru.selfhost.workspace-job-policy.v1", defaultMaximumRuntimeSeconds: values.seconds === "" ? null : Number(values.seconds) }), "runtime");
  });
  content.querySelectorAll("[data-job-action]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/jobs/${encodeURIComponent(button.dataset.job)}/${button.dataset.jobAction}`), "runtime")));
}

async function renderArtifacts() {
  const inventory = await api.request("GET", "/aru/v1/artifacts"); state.data.artifacts = inventory.artifacts;
  content.innerHTML = pageHead("artifacts", t("artifactsTitle"), t("artifactsDetail")) + (inventory.artifacts.length ? `<div class="raised-list">${inventory.artifacts.map((item) => row(item.filename, `${formatBytes(item.byteCount)} · ${formatDate(item.createdAt)} · ${item.producer?.kind ?? ""}`, `<button class="quiet-button" data-download="${escAttr(item.artifactId)}">${esc(t("download"))}</button><button class="danger-button" data-delete="${escAttr(item.artifactId)}">${esc(t("delete"))}</button>`)).join("")}</div>` : empty("▰", t("noArtifacts"), t("noArtifactsDetail")));
  bindDownloads("artifacts", inventory.artifacts, (item) => item.artifactId, (item) => item.filename);
}

async function renderCollaborators() {
  const [drivers, roots, providers] = await Promise.all([
    api.request("GET", "/aru/v1/agent-drivers"), api.request("GET", "/aru/v1/hosted-collaborators"), api.request("GET", "/aru/v1/provider-profiles"),
  ]);
  state.data.collaborators = roots.collaborators;
  content.innerHTML = pageHead("collaborators", t("collaboratorsTitle"), t("collaboratorsDetail"), `<button class="quiet-button" data-refresh-drivers>${esc(t("refreshDrivers"))}</button><button class="primary-button" data-new-collaborator>${esc(t("newCollaborator"))}</button>`)
    + (roots.collaborators.length ? `<div class="raised-list">${roots.collaborators.map((item) => row(item.displayName, `${item.driverId} · ${item.activationStatus} · ${item.toolAccess.mode === "all" ? t("allTools") : `${item.toolAccess.toolNames.length} ${t("selectedTools")}`}`, `<button class="quiet-button" data-collaborator-settings="${escAttr(item.collaboratorId)}">${esc(t("settings"))}</button><button class="primary-button" data-studio="${escAttr(item.collaboratorId)}">${esc(t("studio"))}</button>`)).join("")}</div>` : empty("◌", t("noCollaborators"), t("noCollaboratorsDetail")))
    + sectionBlock(t("providerRoutes"), "", `<div class="section-title"><div></div><button class="quiet-button" data-new-provider>${esc(t("newProvider"))}</button></div>${providers.profiles?.length ? `<div class="raised-list">${providers.profiles.map((profile) => row(profile.displayName, `${profile.protocol} · ${profile.model} · ${profile.health}`, `<button class="quiet-button" data-edit-provider="${escAttr(profile.profileId)}">${esc(t("edit"))}</button><button class="quiet-button" data-test-provider="${escAttr(profile.profileId)}">${esc(t("test"))}</button><button class="danger-button" data-delete-provider="${escAttr(profile.profileId)}">${esc(t("delete"))}</button>`)).join("")}</div>` : empty("◇", t("providerRoutes"), providers.secretStorage?.supported ? t("newProvider") : t("routeUnavailable"))}`);
  content.querySelector("[data-refresh-drivers]").addEventListener("click", () => mutate(() => api.request("POST", "/aru/v1/agent-drivers/refresh"), "collaborators"));
  content.querySelector("[data-new-collaborator]").addEventListener("click", async () => {
    const ready = drivers.drivers.filter((driver) => driver.status === "ready");
    const values = await openForm(t("newCollaborator"), [
      { name: "displayName", label: t("displayName"), required: true },
      { name: "driverId", label: t("driver"), type: "select", options: ready.map((driver) => [driver.id, driver.displayName]) },
      { name: "providerProfileId", label: t("provider"), type: "select", options: [["", "—"], ...(providers.profiles ?? []).map((profile) => [profile.profileId, profile.displayName])] },
    ]);
    if (!values) return;
    await mutate(() => api.request("POST", "/aru/v1/hosted-collaborators", { displayName: values.displayName, driverId: values.driverId, providerProfileId: values.providerProfileId || null }), "collaborators");
  });
  content.querySelectorAll("[data-collaborator-settings]").forEach((button) => button.addEventListener("click", () => editCollaborator(roots.collaborators.find((item) => item.collaboratorId === button.dataset.collaboratorSettings), drivers, providers)));
  content.querySelector("[data-new-provider]").addEventListener("click", () => editProvider());
  content.querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => editProvider(providers.profiles.find((profile) => profile.profileId === button.dataset.editProvider))));
  content.querySelectorAll("[data-test-provider]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/provider-profiles/${button.dataset.testProvider}/test`), "collaborators")));
  content.querySelectorAll("[data-delete-provider]").forEach((button) => button.addEventListener("click", async () => { if (await confirmDialog(t("delete"), t("destructiveTitle"), true)) await mutate(() => api.request("DELETE", `/aru/v1/provider-profiles/${button.dataset.deleteProvider}`), "collaborators"); }));
  content.querySelectorAll("[data-studio]").forEach((button) => button.addEventListener("click", () => renderCollaboratorStudio(roots.collaborators.find((item) => item.collaboratorId === button.dataset.studio))));
}

async function editCollaborator(collaborator, drivers, providers) {
  const driverOptions = drivers.drivers.filter((driver) => driver.status === "ready" || driver.id === collaborator.driverId).map((driver) => [driver.id, driver.displayName]);
  const values = await openForm(t("settings"), [
    { name: "displayName", label: t("displayName"), value: collaborator.displayName, required: true },
    { name: "driverId", label: t("driver"), type: "select", value: collaborator.driverId, options: driverOptions },
    { name: "providerProfileId", label: t("provider"), type: "select", value: collaborator.providerProfileId ?? "", options: [["", "—"], ...(providers.profiles ?? []).map((profile) => [profile.profileId, profile.displayName])] },
    { name: "toolMode", label: t("toolAccess"), type: "select", value: collaborator.toolAccess.mode, options: [["all", t("allTools")], ["selected", t("selectedTools")]] },
    { name: "toolNames", label: t("toolNames"), value: collaborator.toolAccess.toolNames.join(", ") },
  ]);
  if (!values) return;
  await mutate(() => api.request("PUT", `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}`, {
    expectedRevision: collaborator.revision,
    displayName: values.displayName,
    driverId: values.driverId,
    providerProfileId: values.driverId === "api" ? values.providerProfileId || null : null,
    toolAccess: { schema: "aru.selfhost.collaborator-tool-access.v1", mode: values.toolMode, toolNames: values.toolMode === "selected" ? values.toolNames.split(",").map((value) => value.trim()).filter(Boolean) : [] },
  }), "collaborators");
}

async function editProvider(profile = null) {
  const values = await openForm(profile ? t("edit") : t("newProvider"), [
    { name: "displayName", label: t("displayName"), value: profile?.displayName ?? "", required: true },
    { name: "protocol", label: t("providerProtocol"), type: "select", value: profile?.protocol ?? "openai-compatible", options: [["openai-compatible", "OpenAI compatible"], ["anthropic-messages", "Anthropic Messages"]] },
    { name: "baseURL", label: t("baseURL"), value: profile?.baseURL ?? "https://api.openai.com", required: true },
    { name: "path", label: t("requestPath"), value: profile?.path ?? "v1/chat/completions", required: true },
    { name: "model", label: t("model"), value: profile?.model ?? "", required: true }, { name: "authMode", label: t("authMode"), type: "select", value: profile?.authMode ?? "bearer", options: [["bearer", "Bearer"], ["x-api-key", "x-api-key"], ["none", "None"]] },
    { name: "maxOutputTokens", label: t("maxOutput"), type: "number", value: profile?.maxOutputTokens ?? "" }, { name: "maxToolRounds", label: t("maxRounds"), type: "number", value: profile?.maxToolRounds ?? "" },
    { name: "apiKey", label: t("apiKey"), type: "password" },
  ]);
  if (!values) return;
  const method = profile ? "PUT" : "POST";
  const path = profile ? `/aru/v1/provider-profiles/${encodeURIComponent(profile.profileId)}` : "/aru/v1/provider-profiles";
  await mutate(() => api.request(method, path, { expectedRevision: profile?.revision ?? null, displayName: values.displayName, protocol: values.protocol, baseURL: values.baseURL, path: values.path, model: values.model, authMode: values.authMode, maxOutputTokens: values.maxOutputTokens ? Number(values.maxOutputTokens) : null, maxToolRounds: values.maxToolRounds ? Number(values.maxToolRounds) : null, apiKey: values.apiKey || undefined }), "collaborators");
}

async function renderCollaboratorStudio(collaborator) {
  setBusy(true);
  try {
    const id = encodeURIComponent(collaborator.collaboratorId);
    const [conversations, surfaces, projects, cognition, initiative] = await Promise.all([
      api.request("GET", `/aru/v1/hosted-collaborators/${id}/conversations`), api.request("GET", `/aru/v1/hosted-collaborators/${id}/surfaces`), api.request("GET", `/aru/v1/hosted-collaborators/${id}/projects`), api.request("GET", `/aru/v1/hosted-collaborators/${id}/cognition`), api.request("GET", `/aru/v1/hosted-collaborators/${id}/initiative`),
    ]);
    content.innerHTML = pageHead("collaborators", collaborator.displayName, t("collaboratorsDetail"), `<button class="quiet-button" data-back>${esc(t("collaborators"))}</button>`)
      + `<div class="metrics">${metric(conversations.conversations.length, t("conversations"))}${metric(projects.projects.length, t("projects"))}${metric(surfaces.surfaces.length, t("surfaces"))}${metric(cognition.memories.length, t("memories"))}</div>`
      + sectionBlock(t("conversations"), "", `<div class="section-title"><div></div><button class="quiet-button" data-new-conversation>${esc(t("newConversation"))}</button></div>${conversations.conversations.length ? `<div class="raised-list">${conversations.conversations.map((item) => row(item.title, item.lastMessagePreview || formatDate(item.updatedAt), `<button class="quiet-button" data-conversation="${escAttr(item.conversationId)}">${esc(t("open"))}</button>`)).join("")}</div>` : empty("◌", t("noConversations"), t("conversations"))}`)
      + sectionBlock(t("initiative"), t("initiativeHostOwned"), `<div class="section-title"><div></div><button class="quiet-button" data-new-initiative>${esc(t("newInitiative"))}</button></div>${liveInitiativeRules(initiative).length ? `<div class="raised-list">${liveInitiativeRules(initiative).map((rule) => row(rule.title, `${rule.enabled ? formatDate(rule.nextFireAt) : t("initiativePause")} · ${t("initiativeDeliveries", { count: rule.deliveryCount })}${rule.lastFailure ? ` · ${rule.lastFailure}` : ""}`, `<button class="quiet-button" data-initiative-toggle="${escAttr(rule.ruleId)}" data-initiative-enabled="${String(rule.enabled)}">${esc(t(rule.enabled ? "initiativePause" : "initiativeResume"))}</button><button class="quiet-button" data-initiative-run="${escAttr(rule.ruleId)}">${esc(t("initiativeRunNow"))}</button><button class="danger-button" data-initiative-archive="${escAttr(rule.ruleId)}">${esc(t("archive"))}</button>`)).join("")}</div>` : empty("✦", t("noInitiative"), t("initiativeHostOwned"))}`)
      + sectionBlock(t("projects"), t("projectHostOwned"), `<div class="section-title"><div></div><button class="quiet-button" data-new-project>${esc(t("newProject"))}</button></div>${liveProjects(projects).length ? `<div class="raised-list">${liveProjects(projects).map((project) => row(project.title, projectSummary(project), `<button class="quiet-button" data-project-save="${escAttr(project.projectId)}">${esc(t("projectSave"))}</button><button class="primary-button" data-project-publish="${escAttr(project.projectId)}">${esc(t("projectPublish"))}</button>`)).join("")}</div>` : empty("▱", t("noProjects"), t("projectHostOwned"))}`)
      + sectionBlock(t("surfaces"), "", `<div class="section-title"><div></div><button class="quiet-button" data-new-surface>${esc(t("newSurface"))}</button></div>${surfaces.surfaces.length ? `<div class="raised-list">${surfaces.surfaces.map((item) => row(item.title, `${item.networkAccess ?? "none"} · v${item.activeVersionOrdinal}`, `${item.delivery === "bundle" ? "" : `<button class="quiet-button" data-edit-surface="${escAttr(item.surfaceId)}">${esc(t("edit"))}</button>`}${item.activeVersionOrdinal > 1 ? `<button class="quiet-button" data-rollback-surface="${escAttr(item.surfaceId)}">${esc(t("rollback"))}</button>` : ""}<button class="quiet-button" data-archive-surface="${escAttr(item.surfaceId)}">${esc(t(item.archivedAt ? "restore" : "archive"))}</button>`)).join("")}</div>` : empty("▱", t("noSurfaces"), t("surfaces"))}`)
      + sectionBlock(t("cognition"), "", `<div class="detail-panel"><label class="field"><span>${esc(t("instructionEnvironment"))}</span><select id="cognition-environment"><option value="isolated" ${cognition.instructionEnvironment === "isolated" ? "selected" : ""}>${esc(t("isolated"))}</option><option value="inheritCodex" ${cognition.instructionEnvironment === "inheritCodex" ? "selected" : ""}>${esc(t("inheritCodex"))}</option></select></label><label class="field"><span>${esc(t("systemPrompt"))}</span><textarea id="system-prompt">${esc(cognition.systemPrompt)}</textarea></label><button class="primary-button" data-save-cognition>${esc(t("save"))}</button>${recordList(t("memories"), cognition.memories, "memories")}${recordList(t("references"), cognition.references, "references")}</div>`);
    content.querySelector("[data-back]").addEventListener("click", () => selectSection("collaborators"));
    content.querySelector("[data-new-conversation]").addEventListener("click", async () => {
      const values = await openForm(t("newConversation"), [{ name: "title", label: t("conversationTitle") }]); if (!values) return;
      await mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/conversations`, { title: values.title || null }), null, () => renderCollaboratorStudio(collaborator));
    });
    content.querySelectorAll("[data-conversation]").forEach((button) => button.addEventListener("click", () => openConversation(collaborator, button.dataset.conversation)));
    content.querySelector("[data-new-initiative]").addEventListener("click", () => createInitiative(collaborator, initiative));
    content.querySelectorAll("[data-initiative-toggle]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("PUT", `/aru/v1/hosted-collaborators/${id}/initiative/rules/${encodeURIComponent(button.dataset.initiativeToggle)}`, { expectedRevision: initiative.revision, enabled: button.dataset.initiativeEnabled !== "true" }), null, () => renderCollaboratorStudio(collaborator))));
    content.querySelectorAll("[data-initiative-run]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/initiative/rules/${encodeURIComponent(button.dataset.initiativeRun)}/run`, { expectedRevision: initiative.revision }), null, () => renderCollaboratorStudio(collaborator))));
    content.querySelectorAll("[data-initiative-archive]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/initiative/rules/${encodeURIComponent(button.dataset.initiativeArchive)}/archive`, { expectedRevision: initiative.revision }), null, () => renderCollaboratorStudio(collaborator))));
    content.querySelector("[data-new-project]").addEventListener("click", () => createProject(collaborator));
    content.querySelectorAll("[data-project-save]").forEach((button) => button.addEventListener("click", () => saveProject(collaborator, projects, button.dataset.projectSave)));
    content.querySelectorAll("[data-project-publish]").forEach((button) => button.addEventListener("click", () => publishProject(collaborator, projects, surfaces, button.dataset.projectPublish)));
    content.querySelector("[data-new-surface]").addEventListener("click", () => editSurface(collaborator, null));
    content.querySelectorAll("[data-edit-surface]").forEach((button) => button.addEventListener("click", () => editSurface(collaborator, button.dataset.editSurface)));
    content.querySelectorAll("[data-rollback-surface]").forEach((button) => button.addEventListener("click", () => rollbackSurface(collaborator, button.dataset.rollbackSurface)));
    content.querySelectorAll("[data-archive-surface]").forEach((button) => button.addEventListener("click", async () => {
      const surface = surfaces.surfaces.find((item) => item.surfaceId === button.dataset.archiveSurface);
      await mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/surfaces/${encodeURIComponent(surface.surfaceId)}/${surface.archivedAt ? "restore" : "archive"}`, { expectedRevision: surface.revision }), null, () => renderCollaboratorStudio(collaborator));
    }));
    content.querySelector("[data-save-cognition]").addEventListener("click", () => mutate(() => api.request("PUT", `/aru/v1/hosted-collaborators/${id}/cognition`, { expectedRevision: cognition.revision, instructionEnvironment: document.querySelector("#cognition-environment").value, systemPrompt: document.querySelector("#system-prompt").value }), null, () => renderCollaboratorStudio(collaborator)));
    content.querySelectorAll("[data-new-record]").forEach((button) => button.addEventListener("click", () => editCognitionRecord(collaborator, cognition, button.dataset.newRecord)));
    content.querySelectorAll("[data-edit-record]").forEach((button) => button.addEventListener("click", () => editCognitionRecord(collaborator, cognition, button.dataset.recordKind, button.dataset.editRecord)));
    content.querySelectorAll("[data-archive-record]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/cognition/${button.dataset.recordKind}/${encodeURIComponent(button.dataset.archiveRecord)}/${button.dataset.recordArchived === "true" ? "restore" : "archive"}`, { expectedRevision: cognition.revision }), null, () => renderCollaboratorStudio(collaborator))));
  } catch (error) { renderSectionFailure(error); }
  finally { setBusy(false); }
}

function liveInitiativeRules(initiative) {
  return initiative.rules.filter((rule) => rule.archivedAt === null).sort((left, right) => right.updatedAt - left.updatedAt);
}

function liveProjects(inventory) {
  return inventory.projects.filter((project) => project.archivedAt === null).sort((left, right) => right.updatedAt - left.updatedAt);
}

function projectSummary(project) {
  const repository = project.repository;
  const git = repository
    ? [repository.branch, repository.commit?.slice(0, 8), repository.dirty ? t("projectDirty") : null].filter(Boolean).join(" · ")
    : project.workspacePath;
  return `${git} · ${t("projectCheckpoints", { count: project.checkpointCount })} · ${t(project.surfaceId ? "projectPublished" : "projectUnpublished")}`;
}

async function createProject(collaborator) {
  const values = await openForm(t("newProject"), [
    { name: "title", label: t("projectTitle"), required: true },
    { name: "repositoryURL", label: t("projectGitHub") },
    { name: "entryPath", label: t("projectEntry"), value: "index.html", required: true },
  ], t("create"));
  if (!values) return;
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/projects`;
  await mutate(() => api.request("POST", root, {
    title: values.title,
    repositoryURL: values.repositoryURL || null,
    entryPath: values.entryPath,
  }), null, () => renderCollaboratorStudio(collaborator));
}

async function saveProject(collaborator, inventory, projectId) {
  const project = inventory.projects.find((item) => item.projectId === projectId);
  const values = await openForm(t("projectSave"), [
    { name: "note", label: t("projectNote") },
  ], t("projectSave"));
  if (!values) return;
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/projects/${encodeURIComponent(project.projectId)}`;
  await mutate(() => api.request("POST", `${root}/checkpoint`, {
    expectedRevision: project.revision,
    note: values.note,
  }), null, () => renderCollaboratorStudio(collaborator));
}

async function publishProject(collaborator, inventory, surfaces, projectId) {
  const project = inventory.projects.find((item) => item.projectId === projectId);
  const surface = surfaces.surfaces.find((item) => item.surfaceId === project.surfaceId);
  const values = await openForm(t("projectPublish"), [
    { name: "note", label: t("projectNote") },
    { name: "networkAccess", label: t("projectNetwork"), type: "select", value: surface?.networkAccess ?? "none", options: [["none", t("networkNone")], ["outbound", t("networkOutbound")]] },
  ], t("projectPublish"));
  if (!values) return;
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/projects/${encodeURIComponent(project.projectId)}`;
  await mutate(() => api.request("POST", `${root}/publish`, {
    expectedRevision: project.revision,
    expectedSurfaceRevision: surface?.revision ?? null,
    note: values.note,
    networkAccess: values.networkAccess,
  }), null, () => renderCollaboratorStudio(collaborator));
}

async function createInitiative(collaborator, initiative) {
  const values = await openForm(t("newInitiative"), [
    { name: "title", label: t("initiativeTitle"), required: true },
    { name: "goal", label: t("initiativeGoal"), type: "textarea", required: true },
    { name: "instructions", label: t("initiativeInstructions"), type: "textarea" },
    { name: "fireAfterMinutes", label: t("initiativeWhen"), type: "select", value: "30", options: [["1", "1 min"], ["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 h"], ["180", "3 h"]] },
    { name: "recurrenceMinutes", label: t("initiativeRepeat"), type: "select", value: "0", options: [["0", t("initiativeOnce")], ["60", t("initiativeHourly")], ["1440", t("initiativeDaily")], ["10080", t("initiativeWeekly")]] },
    { name: "notificationsEnabled", label: t("initiativeNotify"), type: "select", value: "true", options: [["true", t("enabled")], ["false", t("disabled")]] },
  ], t("create"));
  if (!values) return;
  const id = encodeURIComponent(collaborator.collaboratorId);
  const fireAfterMinutes = Number(values.fireAfterMinutes);
  await mutate(() => api.request("POST", `/aru/v1/hosted-collaborators/${id}/initiative`, {
    expectedRevision: initiative.revision,
    title: values.title,
    goal: values.goal,
    instructions: values.instructions,
    nextFireAt: Date.now() + fireAfterMinutes * 60_000,
    recurrenceMinutes: Number(values.recurrenceMinutes) || null,
    notificationsEnabled: values.notificationsEnabled === "true",
    enabled: true,
  }), null, () => renderCollaboratorStudio(collaborator));
}

async function editSurface(collaborator, surfaceId) {
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/surfaces`;
  const surface = surfaceId ? await api.request("GET", `${root}/${encodeURIComponent(surfaceId)}`) : null;
  if (surface?.delivery === "bundle") {
    showToast(t("bundleEditUnavailable"), true);
    return;
  }
  const values = await openForm(surface ? t("editSurface") : t("newSurface"), [
    { name: "title", label: t("surfaceTitle"), value: surface?.title ?? "", required: true },
    { name: "sourceHTML", label: t("htmlSource"), type: "textarea", value: surface?.sourceHTML ?? "<!doctype html>\n<html><body></body></html>", required: true },
    { name: "note", label: t("note"), value: t("consoleVersionNote") },
    { name: "networkAccess", label: t("networkAccess"), type: "select", value: surface?.networkAccess ?? "none", options: [["none", t("networkNone")], ["outbound", t("networkOutbound")]] },
  ]);
  if (!values) return;
  const method = surface ? "PUT" : "POST";
  const path = surface ? `${root}/${encodeURIComponent(surface.surfaceId)}` : root;
  const body = surface ? { ...values, expectedRevision: surface.revision } : values;
  await mutate(() => api.request(method, path, body), null, () => renderCollaboratorStudio(collaborator));
}

async function rollbackSurface(collaborator, surfaceId) {
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/surfaces/${encodeURIComponent(surfaceId)}`;
  const surface = await api.request("GET", root);
  const versions = (surface.versions ?? []).filter((version) => version.versionId !== surface.activeVersionId);
  if (!versions.length) return;
  const values = await openForm(t("rollbackVersion"), [{ name: "versionId", label: t("version"), type: "select", options: versions.map((version) => [version.versionId, `v${version.ordinal} · ${version.note}`]) }], t("rollback"));
  if (!values) return;
  await mutate(() => api.request("POST", `${root}/rollback`, { expectedRevision: surface.revision, versionId: values.versionId, note: t("consoleRollbackNote") }), null, () => renderCollaboratorStudio(collaborator));
}

async function editCognitionRecord(collaborator, cognition, kind, recordId = null) {
  const idKey = kind === "memories" ? "memoryId" : "referenceId";
  const record = recordId ? cognition[kind].find((item) => item[idKey] === recordId) : null;
  const values = await openForm(kind === "memories" ? t("newMemory") : t("newReference"), [
    { name: "title", label: t("recordTitle"), value: record?.title ?? "", required: true },
    { name: "content", label: t("recordContent"), type: "textarea", value: record?.content ?? "", required: true },
  ]);
  if (!values) return;
  const root = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/cognition/${kind}`;
  await mutate(() => api.request(record ? "PUT" : "POST", record ? `${root}/${encodeURIComponent(record[idKey])}` : root, { expectedRevision: cognition.revision, ...values }), null, () => renderCollaboratorStudio(collaborator));
}

async function openConversation(collaborator, conversationId) {
  setBusy(true);
  try {
    const path = `/aru/v1/hosted-collaborators/${encodeURIComponent(collaborator.collaboratorId)}/conversations/${encodeURIComponent(conversationId)}`;
    const conversation = await api.request("GET", path);
    const active = ["queued", "starting", "streaming", "waitingApproval", "cancelling"].includes(conversation.activeTurn?.state);
    content.innerHTML = pageHead("conversations", conversation.title, t("conversations"), `<button class="quiet-button" data-back-studio>${esc(t("studio"))}</button>${active ? `<button class="danger-button" data-stop-turn>${esc(t("stop"))}</button>` : ""}`)
      + `<section class="conversation"><div class="messages">${(conversation.messages ?? []).map((message) => `<div class="message ${escAttr(message.role)}">${esc(message.content)}</div>`).join("") || empty("◌", t("noConversations"), t("conversations"))}</div>${(conversation.approvals ?? []).filter((approval) => approval.state === "pending").map((approval) => `<div class="approval"><strong>${esc(approval.title)}</strong><div class="row-actions"><button class="primary-button" data-approval="${escAttr(approval.approvalId)}" data-decision="allowOnce">${esc(t("approve"))}</button><button class="quiet-button" data-approval="${escAttr(approval.approvalId)}" data-decision="allowSession">${esc(t("approveSession"))}</button><button class="danger-button" data-approval="${escAttr(approval.approvalId)}" data-decision="deny">${esc(t("deny"))}</button></div></div>`).join("")}<div class="composer"><textarea id="composer"></textarea><button class="primary-button" data-send>${esc(t("send"))}</button></div></section>`;
    content.querySelector("[data-back-studio]").addEventListener("click", () => renderCollaboratorStudio(collaborator));
    content.querySelector("[data-stop-turn]")?.addEventListener("click", () => mutate(() => api.request("POST", `${path}/turns/${encodeURIComponent(conversation.activeTurn.turnId)}/cancel`), null, () => openConversation(collaborator, conversationId)));
    content.querySelector("[data-send]").addEventListener("click", async () => {
      const text = document.querySelector("#composer").value.trim(); if (!text) return;
      await mutate(() => api.request("PUT", `${path}/messages`, { clientRequestId: crypto.randomUUID(), text }), null, () => openConversation(collaborator, conversationId));
    });
    content.querySelectorAll("[data-approval]").forEach((button) => button.addEventListener("click", () => mutate(() => api.request("PUT", `${path}/approvals/${encodeURIComponent(button.dataset.approval)}`, { decision: button.dataset.decision }), null, () => openConversation(collaborator, conversationId))));
  } catch (error) { renderSectionFailure(error); }
  finally { setBusy(false); }
}

function bindDownloads(kind, items, id, filename) {
  content.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", async () => {
    const item = items.find((candidate) => id(candidate) === button.dataset.download);
    try { await api.download(`/aru/v1/${kind}/${encodeURIComponent(id(item))}`, filename(item)); showToast(t("operationDone")); } catch (error) { showToast(error.message, true); }
  }));
  content.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!await confirmDialog(t("delete"), t("destructiveTitle"), true)) return;
    await mutate(() => api.request("DELETE", `/aru/v1/${kind}/${encodeURIComponent(button.dataset.delete)}`), kind);
  }));
}

async function mutate(operation, section = state.section, after) {
  setBusy(true);
  try { await operation(); showToast(t("operationDone")); if (after) await after(); else if (section) await selectSection(section); }
  catch (error) { showToast(error.message, true); }
  finally { setBusy(false); }
}

function pageHead(key, title, detail, actions = `<button class="quiet-button" data-refresh>${esc(t("refresh"))}</button>`) {
  queueMicrotask(() => content.querySelector("[data-refresh]")?.addEventListener("click", () => selectSection(state.section)));
  return `<header class="page-head"><div><p class="eyebrow">${esc(t(key))}</p><h2>${esc(title)}</h2><p>${esc(detail)}</p></div><div class="head-actions">${actions}</div></header>`;
}
function sectionBlock(title, detail, body) { return `<section class="section"><div class="section-title"><div><h3>${esc(title)}</h3>${detail ? `<p>${esc(detail)}</p>` : ""}</div></div>${body}</section>`; }
function metric(value, label) { return `<div class="metric"><strong>${esc(String(value ?? 0))}</strong><span>${esc(label)}</span></div>`; }
function row(title, detail, actions = "") { return `<article class="list-row"><div class="row-main"><div class="row-title">${esc(title ?? t("unknown"))}</div><div class="row-detail">${esc(detail ?? "")}</div></div><div class="row-actions">${actions}</div></article>`; }
function empty(symbol, title, detail) { return `<div class="empty"><div><div class="empty-symbol">${symbol}</div><h3>${esc(title)}</h3><p>${esc(detail)}</p></div></div>`; }
function recordList(title, records, kind) {
  const idKey = kind === "memories" ? "memoryId" : "referenceId";
  const addLabel = kind === "memories" ? t("newMemory") : t("newReference");
  return `<div class="section"><div class="section-title"><h3>${esc(title)}</h3><button class="quiet-button" data-new-record="${kind}">${esc(addLabel)}</button></div>${records.length ? `<div class="raised-list">${records.map((record) => row(record.title, record.archivedAt ? t("archive") : formatDate(record.updatedAt), `<button class="quiet-button" data-edit-record="${escAttr(record[idKey])}" data-record-kind="${kind}">${esc(t("edit"))}</button><button class="quiet-button" data-archive-record="${escAttr(record[idKey])}" data-record-kind="${kind}" data-record-archived="${Boolean(record.archivedAt)}">${esc(t(record.archivedAt ? "restore" : "archive"))}</button>`)).join("")}</div>` : `<p class="row-detail">${esc(t("noCognitionRecords"))}</p>`}</div>`;
}

async function openForm(title, fields, confirmLabel = t("save")) {
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-confirm").textContent = confirmLabel;
  document.querySelector("#dialog-cancel").textContent = t("cancel");
  document.querySelector("#dialog-confirm").className = "primary-button";
  document.querySelector("#dialog-body").innerHTML = fields.map((field) => fieldHTML(field)).join("");
  dialog.showModal();
  const result = await new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
  if (result !== "confirm") return null;
  const values = {};
  for (const field of fields) values[field.name] = document.querySelector(`[name="${CSS.escape(field.name)}"]`).value;
  return values;
}

async function confirmDialog(title, detail, destructive = false) {
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-body").innerHTML = `<p class="row-detail">${esc(detail)}</p>`;
  document.querySelector("#dialog-confirm").textContent = t("confirm");
  document.querySelector("#dialog-confirm").className = destructive ? "danger-button" : "primary-button";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}
async function messageDialog(title, html) {
  document.querySelector("#dialog-title").textContent = title; document.querySelector("#dialog-body").innerHTML = html;
  document.querySelector("#dialog-confirm").textContent = t("close"); document.querySelector("#dialog-confirm").className = "primary-button";
  document.querySelector("#dialog-cancel").classList.add("hidden"); dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true })); document.querySelector("#dialog-cancel").classList.remove("hidden");
}
function fieldHTML(field) {
  const attrs = `name="${escAttr(field.name)}" ${field.required ? "required" : ""} ${field.disabled ? "disabled" : ""}`;
  let input = `<input ${attrs} type="${escAttr(field.type ?? "text")}" value="${escAttr(field.value ?? "")}">`;
  if (field.type === "textarea") input = `<textarea ${attrs}>${esc(field.value ?? "")}</textarea>`;
  if (field.type === "select") input = `<select ${attrs}>${(field.options ?? []).map(([value, label]) => `<option value="${escAttr(value)}" ${String(value) === String(field.value ?? "") ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  return `<label class="field"><span>${esc(field.label)}</span>${input}${field.hint ? `<small class="field-hint">${esc(field.hint)}</small>` : ""}</label>`;
}

function renderFailure(error) {
  content.innerHTML = `<div class="failure-state"><div><div class="empty-symbol">!</div><h2>${esc(t("failureTitle"))}</h2><p>${esc(error.message)}</p><div class="head-actions"><button class="quiet-button" data-repair>${esc(t("repair"))}</button><button class="primary-button" data-retry>${esc(t("retry"))}</button></div></div></div>`;
  content.querySelector("[data-retry]").addEventListener("click", boot);
  content.querySelector("[data-repair]").addEventListener("click", async () => { try { await api.repairConnection(); await boot(); } catch (failure) { showToast(failure.message, true); } });
}
function renderSectionFailure(error) {
  content.innerHTML = pageHead(state.section, t(state.section), "") + `<div class="failure-state"><div><div class="empty-symbol">!</div><h2>${esc(t("failureTitle"))}</h2><p>${esc(error.message)}</p><button class="primary-button" data-retry-section>${esc(t("retry"))}</button></div></div>`;
  content.querySelector("[data-retry-section]").addEventListener("click", () => selectSection(state.section));
}
function renderUpdate() {
  const button = document.querySelector("#update-button");
  if (!state.update) { button.classList.add("hidden"); return; }
  button.textContent = t("updateAvailable", { version: state.update.version }); button.classList.remove("hidden");
}
function updateBadges() {
  const counts = { backups: state.data.backups?.length, plugins: state.data.plugins?.length, workspaces: state.data.workspaces?.length, runtime: state.data.runtime?.length, artifacts: state.data.artifacts?.length, collaborators: state.data.collaborators?.length, mcp: state.data.mcp?.length };
  for (const [key, value] of Object.entries(counts)) { const badge = navigation.querySelector(`[data-badge="${key}"]`); if (badge && value !== undefined) badge.textContent = value; }
}
function setBusy(value) { state.busy = value; activity.classList.toggle("hidden", !value); }
let toastTimer;
function showToast(message, error = false) { clearTimeout(toastTimer); toast.textContent = message; toast.className = `toast visible${error ? " error" : ""}`; toastTimer = setTimeout(() => { toast.className = "toast"; }, 3200); }
function formatDate(value) { if (!value) return ""; return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatBytes(value) { const bytes = Number(value ?? 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function escAttr(value) { return esc(value).replace(/`/g, "&#96;"); }
