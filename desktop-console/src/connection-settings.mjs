import { connectionOrigin } from "./connection-address.mjs";

const copy = {
  zh: {
    title: "手机远程连接", detail: "添加已配置好的公网 HTTPS 或 Tailscale 地址，让手机远程连接这台电脑。",
    invalid: "地址格式不正确：请填写公网 HTTPS 或 Tailscale 地址，不带路径、账号密码或查询参数。", different: "这个地址连到了另一台 Host，请核对地址。", unavailable: "暂时无法连接，请检查域名、端口和服务器防火墙。",
    empty: "还没有添加远程地址。", add: "添加地址", save: "保存连接地址", reset: "撤销修改", remove: "移除", check: "检查连接", checking: "正在检查…",
    checked: "已连接到这台 Host，可以在手机上试试。", url: "连接地址", kind: "连接方式", public: "公网 HTTPS", tailscale: "Tailscale",
    hint: "填写地址和端口，不带路径。公网连接需要 HTTPS；Tailscale 可以使用 http://100.100.100.100:8787。", duplicate: "这个地址已经添加。",
    saved: "连接地址已保存，手机重新读取 Host 后可使用。", failed: "未保存，输入已保留：", unsupported: "当前 Host 尚不支持额外连接地址，请先更新 Host Core。",
  },
  en: {
    title: "Remote phone connections", detail: "Add a configured public HTTPS or Tailscale address to connect your phone remotely.",
    invalid: "Enter public HTTPS or Tailscale without a path, credentials or query.", different: "This address belongs to a different Host. Check the address.", unavailable: "Connection unavailable. Check DNS, port and server firewall.",
    empty: "No remote addresses yet.", add: "Add address", save: "Save addresses", reset: "Discard changes", remove: "Remove", check: "Check connection", checking: "Checking…",
    checked: "Connected to this Host. Try connecting from your phone.", url: "Connection address", kind: "Connection type", public: "Public HTTPS", tailscale: "Tailscale",
    hint: "Enter an origin and optional port, without a path. Public connections require HTTPS; Tailscale may use http://100.100.100.100:8787.", duplicate: "This address has already been added.",
    saved: "Addresses saved. Refresh the Host on your phone to use them.", failed: "Not saved; your input is retained: ", unsupported: "Update Host Core to support additional connection addresses.",
  },
};
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function connectionSettingsPanel(locale, supported) {
  const c = copy[locale] ?? copy.en;
  return `<section class="hero connection-settings"><h3>${c.title}</h3><p>${c.detail}</p>${supported
    ? `<div data-address-rows></div><p class="row-detail">${c.hint}</p><div class="address-actions"><button class="quiet-button" data-address-add>${c.add}</button><button class="quiet-button" data-address-reset>${c.reset}</button><button class="primary-button" data-address-save>${c.save}</button></div><p data-address-status role="status" aria-live="polite"></p>`
    : `<p>${c.unsupported}</p>`}</section>`;
}

export function bindConnectionSettings(root, api, locale, settings, onSaved) {
  const panel = root.querySelector('.connection-settings');
  if (!panel?.querySelector('[data-address-rows]')) return;
  const c = copy[locale] ?? copy.en;
  const rows = panel.querySelector('[data-address-rows]');
  const status = panel.querySelector('[data-address-status]');
  let draft = structuredClone(settings.additionalTransports ?? []);
  let saving = false;
  const failureMessage = error => error.code === 'invalid_address' ? c.invalid
    : error.code === 'different_host' ? c.different : error.code === 'connection_unavailable' ? c.unavailable + '\n' + error.message : error.message;
  const controls = () => panel.querySelectorAll('button,input,select');
  function render() {
    rows.innerHTML = draft.length ? draft.map((address, i) => `<article class="connection-address" data-address-index="${i}"><label>${c.kind}<select data-address-kind><option value="public-https" ${address.kind === 'public-https' ? 'selected' : ''}>${c.public}</option><option value="tailscale" ${address.kind === 'tailscale' ? 'selected' : ''}>${c.tailscale}</option></select></label><label>${c.url}<input type="url" data-address-url value="${esc(address.baseUrl)}" placeholder="https://host.example.com" autocomplete="off" spellcheck="false"></label><div class="address-actions"><button class="quiet-button" data-address-check>${c.check}</button><button class="danger-button" data-address-remove>${c.remove}</button></div><p data-address-check-status role="status"></p></article>`).join('') : `<p class="row-detail">${c.empty}</p>`;
  }
  panel.addEventListener('input', event => {
    const row = event.target.closest('[data-address-index]');
    if (!row) return;
    const address = draft[Number(row.dataset.addressIndex)];
    address.kind = row.querySelector('[data-address-kind]').value;
    address.baseUrl = row.querySelector('[data-address-url]').value;
    row.querySelector('[data-address-check-status]').textContent = '';
    status.textContent = '';
  });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || saving) return;
    if (button.hasAttribute('data-address-add')) {
      draft.push({ id: `remote_${crypto.randomUUID().replaceAll('-', '')}`, kind: 'public-https', baseUrl: '', priority: 20 }); render(); rows.lastElementChild.querySelector('input').focus(); status.textContent = ''; return;
    }
    if (button.hasAttribute('data-address-reset')) { draft = structuredClone(settings.additionalTransports ?? []); render(); status.textContent = ''; return; }
    const row = button.closest('[data-address-index]');
    if (button.hasAttribute('data-address-remove')) { draft.splice(Number(row.dataset.addressIndex), 1); render(); status.textContent = ''; return; }
    if (button.hasAttribute('data-address-check')) {
      const address = { ...draft[Number(row.dataset.addressIndex)] };
      const result = row.querySelector('[data-address-check-status]');
      button.disabled = true; result.textContent = c.checking;
      try {
        connectionOrigin(address.kind, address.baseUrl);
        const check = await api.checkConnectionAddress(address.kind, address.baseUrl);
        if (!check.ok) throw check;
        if (row.isConnected && row.querySelector('input').value === address.baseUrl && row.querySelector('select').value === address.kind) result.textContent = c.checked;
      } catch (error) {
        if (row.isConnected && row.querySelector('input').value === address.baseUrl && row.querySelector('select').value === address.kind) result.textContent = failureMessage(error);
      } finally { button.disabled = false; }
      return;
    }
    if (button.hasAttribute('data-address-save')) {
      try {
        const origins = new Set();
        const addresses = draft.map(address => {
          const baseUrl = connectionOrigin(address.kind, address.baseUrl);
          if (origins.has(baseUrl)) throw new Error(c.duplicate);
          origins.add(baseUrl); return { ...address, baseUrl };
        });
        saving = true; controls().forEach(control => { control.disabled = true; });
        const updated = await api.request('PUT', '/aru/v1/node-settings', { schema: settings.schema, expectedRevision: settings.revision, displayName: settings.displayName, additionalTransports: addresses });
        if (!panel.isConnected) return;
        settings = updated; draft = structuredClone(updated.additionalTransports ?? []); render(); status.textContent = c.saved; onSaved(updated);
      } catch (error) { if (panel.isConnected) status.textContent = c.failed + failureMessage(error); }
      finally { saving = false; controls().forEach(control => { control.disabled = false; }); }
    }
  });
  render();
}
