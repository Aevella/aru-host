export function hostReleaseLabel(value, locale = "en") {
  return value?.releaseVersion ?? (locale === "zh" ? "版本待确认" : "Release unknown");
}
export function turnActions(turn) {
  return { canCancel: turn?.canCancel === true, cancellation: turn?.cancellation ?? null };
}
export function driverGuidance(drivers, locale = "en") {
  if (drivers.some(driver => driver.status === "ready")) return null;
  return locale === "zh"
    ? "还没有就绪的执行方式。使用模型 API：先添加并测试模型路线。使用 Codex：先安装并登录 Codex，再重新探测驱动。"
    : "No execution driver is ready. For a model API, add and test a model route. For Codex, install and sign in to Codex, then refresh drivers.";
}
