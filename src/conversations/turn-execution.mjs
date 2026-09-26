// Runtime of one admitted turn. Durable state and projection stay in the
// conversation owner; this object only holds cancellable work and its receipts.
export function createTurnExecution() {
  const controller = new AbortController();
  const tools = new Set();
  let started = Promise.resolve(null);
  let stopping;
  return {
    signal: controller.signal,
    start(operation) { started = Promise.resolve().then(operation); return started; },
    tool(operation) {
      controller.signal.throwIfAborted();
      const task = Promise.resolve().then(operation);
      tools.add(task);
      task.finally(() => tools.delete(task)).catch(() => {});
      return task;
    },
    stop(driver) {
      controller.abort();
      if (!stopping) {
        stopping = (async () => {
          const receipt = await started.catch(() => null);
          if (receipt) await driver.interrupt(receipt.threadId, receipt.turnId);
          // An already-admitted tool may not support abort. Do not call it stopped
          // or admit the next turn until its actual side effect has settled.
          await Promise.allSettled([...tools]);
        })().finally(() => { stopping = undefined; });
      }
      return stopping;
    },
  };
}

export function waitForTurnStop(operation, milliseconds) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("停止尚未确认，请重试；本轮仍保持占用，其他对话不受影响。")), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
