const copy = {
  zh: {
    title: "脚本与容器插件 · 可选",
    detail: "用于运行 Python、Node.js、Shell 工作区任务和容器插件。项目文件、网页发布和手机连接不需要它。",
    steps: "1. 打开官方安装说明，安装 Podman Desktop（已有 Docker 也可以）。2. 完成引导并启动容器环境。3. 回到这里检测并启用。Mac / Windows 需要虚拟机，可能需要系统权限或重启电脑。",
    cost: "检测会下载任务镜像并验证三种脚本与文件读写，可能需要几分钟；成功后重启 Host，会中断正在运行的工作。",
    install: "打开官方安装说明", verify: "检测并启用", busy: "正在准备镜像并验证…",
    configured: "已配置容器环境", missing: "尚未启用，可继续使用基础功能", success: "验证通过，Host 已启用容器任务。",
  },
  en: {
    title: "Scripts and container plugins · Optional",
    detail: "Runs Python, Node.js and Shell workspace jobs and container plugins. Project files, page publication and phone pairing work independently.",
    steps: "1. Open the official instructions and install Podman Desktop (existing Docker also works). 2. Complete onboarding and start the engine. 3. Return here to verify and enable. Mac / Windows require a virtual machine and may need system permissions or a reboot.",
    cost: "Verification downloads job images and checks all three runtimes and file access. This may take several minutes. Success restarts Host and interrupts running work.",
    install: "Open official installation guide", verify: "Verify and enable", busy: "Preparing images and verifying…",
    configured: "Container runtime configured", missing: "Optional runtime not enabled; core features remain available", success: "Verified. Host has enabled container jobs.",
  },
};

export function containerSetupPanel(locale, configured) {
  const c = copy[locale] ?? copy.en;
  return `<section class="hero container-setup"><h3>${c.title}</h3><p>${c.detail}</p><p data-container-status role="status">${configured ? c.configured : c.missing}</p><p>${c.steps}</p><p>${c.cost}</p><button class="quiet-button" data-container-install>${c.install}</button> <button class="primary-button" data-container-verify>${c.verify}</button></section>`;
}

export function bindContainerSetup(root, api, locale, onEnabled) {
  const c = copy[locale] ?? copy.en;
  const status = root.querySelector("[data-container-status]");
  root.querySelector("[data-container-install]").addEventListener("click", async () => {
    try { await api.openContainerSetup(); }
    catch (error) { status.textContent = error.message; }
  });
  const button = root.querySelector("[data-container-verify]");
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = c.busy;
    try {
      const manifest = await api.setupContainerRuntime();
      onEnabled(manifest);
      status.textContent = c.success;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
