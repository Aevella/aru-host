import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Consecutive rounds in which the model's tool arguments could not be parsed
// before the turn stops instead of retrying again.
const MAX_UNREADABLE_ARGUMENT_ROUNDS = 3;

export function createDirectAPIDriver({ profileForId, readSecret, fetchImpl = fetch, log = () => {} }) {
  const activeTurns = new Map();

  function forProfile(profileId) {
    return {
      status() {
        const profile = profileForId(profileId);
        return profile?.hasSecret ? "ready" : "unavailable";
      },
      validateAttachments(attachments) {
        validateDirectAttachments(profileForId(profileId), attachments);
      },
      async startTurn(options) {
        const profile = profileForId(profileId);
        if (!profile) throw new Error("这个模型 API 配置已经不存在");
        const secret = readSecret(profileId);
        if (!secret && profile.authMode !== "none") throw new Error("这个模型 API 配置缺少钥匙串密钥");
        const threadId = options.threadId ?? `api_thread_${randomUUID()}`;
        const turnId = `api_turn_${randomUUID()}`;
        const controller = new AbortController();
        activeTurns.set(turnKey(threadId, turnId), controller);
        setImmediate(() => runTurn({
          ...options,
          profile,
          secret,
          threadId,
          turnId,
          signal: controller.signal,
        }).catch((error) => {
          options.handler.onNotification("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              status: controller.signal.aborted ? "interrupted" : "failed",
              error: { message: publicFailure(error, [secret]) },
            },
          });
        }).finally(() => activeTurns.delete(turnKey(threadId, turnId))));
        return { threadId, turnId };
      },
      async interrupt(threadId, turnId) {
        activeTurns.get(turnKey(threadId, turnId))?.abort();
      },
    };
  }

  async function testProfile(profileId) {
    const profile = profileForId(profileId);
    if (!profile) throw new Error("unknown provider profile");
    const secret = readSecret(profileId);
    if (!secret && profile.authMode !== "none") throw new Error("API key is missing from the operating-system secret store");
    try {
      const request = profile.protocol === "anthropic-messages"
        ? anthropicRequest(profile, secret, "只回复 OK", [], [], 1)
        : openAIRequest(profile, secret, "只回复 OK", [], [], 1);
      const response = await fetchImpl(request.url, request.init);
      await responseBody(response);
      return { ok: true };
    } catch (error) {
      throw new Error(publicFailure(error, [secret]));
    }
  }

  async function runTurn({
    profile,
    secret,
    instructions,
    historyMessages,
    tools,
    text,
    attachments = [],
    handler,
    threadId,
    turnId,
    signal,
  }) {
    let protocolMessages = profile.protocol === "anthropic-messages"
      ? anthropicHistory(historyMessages, text, attachments)
      : openAIHistory(historyMessages, text, attachments);
    let completedToolRounds = 0;
    let unreadableRounds = 0;
    while (!signal.aborted) {
      const request = profile.protocol === "anthropic-messages"
        ? anthropicRequest(profile, secret, instructions, protocolMessages, tools, undefined, signal, true)
        : openAIRequest(profile, secret, instructions, protocolMessages, tools, undefined, signal, true);
      const response = await fetchImpl(request.url, request.init);
      const result = await modelResponse(response, profile.protocol, async (delta) => {
        await handler.onNotification("item/agentMessage/delta", {
          threadId,
          turnId,
          itemId: `api_message_${randomUUID()}`,
          delta,
        });
      });

      if (result.text) {
        await handler.onNotification("item/agentMessage/delta", {
          threadId,
          turnId,
          itemId: `api_message_${randomUUID()}`,
          delta: result.text,
        });
      }
      if (result.toolCalls.length === 0) {
        await handler.onNotification("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed", items: [] },
        });
        return;
      }
      if (profile.maxToolRounds !== null && profile.maxToolRounds !== undefined
          && completedToolRounds >= profile.maxToolRounds) {
        throw new Error(`已达到你设置的连续工具回合上限（${profile.maxToolRounds} 回合）`);
      }
      const truncatedCall = result.truncated
        ? (result.toolCalls.find((call) => call.argumentsError) ?? result.toolCalls[0])
        : null;
      if (truncatedCall) {
        // A truncated batch is not complete even if its arguments are empty or
        // happen to be valid JSON. Stop before any side effect in this round.
        throw truncatedToolCallFailure(profile, truncatedCall);
      }
      const unreadableCall = result.toolCalls.find((call) => call.argumentsError);
      unreadableRounds = unreadableCall ? unreadableRounds + 1 : 0;
      if (unreadableRounds >= MAX_UNREADABLE_ARGUMENT_ROUNDS) {
        // The model gets feedback and a retry, but a profile without a tool
        // round limit must not spin forever on a model that never emits JSON.
        throw new Error(`模型连续 ${unreadableRounds} 轮返回无法读取的工具参数（${unreadableCall.argumentsError}），Aru 已停止这一轮。请换一个更稳定支持工具调用的模型。`);
      }
      completedToolRounds += 1;
      const toolResults = [];
      for (const call of result.toolCalls) {
        const item = { id: call.id, type: "dynamicToolCall", tool: call.name };
        await handler.onNotification("item/started", { threadId, turnId, item });
        if (call.argumentsError) {
          // Unreadable arguments without truncation: hand the failure back to
          // the model as a tool error so it can re-issue the call, instead of
          // ending the whole turn.
          log(`direct API tool ${call.name} skipped: ${call.argumentsError}`);
          toolResults.push({
            ...call,
            value: { error: `${call.argumentsError}。这次调用没有执行，请用合法的 JSON object 重新发起工具调用。` },
            isError: true,
          });
          await handler.onNotification("item/completed", { threadId, turnId, item });
          continue;
        }
        try {
          const value = await handler.onToolCall({
            threadId,
            turnId,
            callId: call.id,
            tool: call.name,
            arguments: call.arguments,
          });
          toolResults.push({ ...call, value, isError: false });
        } catch (error) {
          toolResults.push({ ...call, value: { error: publicFailure(error, [secret]) }, isError: true });
        }
        await handler.onNotification("item/completed", { threadId, turnId, item });
      }
      protocolMessages = profile.protocol === "anthropic-messages"
        ? appendAnthropicToolRound(protocolMessages, result, toolResults)
        : appendOpenAIToolRound(protocolMessages, result, toolResults);
    }
    log("direct API turn interrupted");
  }

  return { forProfile, testProfile };
}

function openAIRequest(profile, secret, instructions, messages, tools, maxTokens, signal, stream = false) {
  const body = {
    model: profile.model,
    messages: [
      ...(instructions ? [{ role: "system", content: instructions }] : []),
      ...(Array.isArray(messages) ? messages : [{ role: "user", content: String(messages) }]),
    ],
  };
  if (tools.length > 0) body.tools = tools.map(openAITool);
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (stream) body.stream = true;
  return {
    url: endpoint(profile),
    init: {
      method: "POST",
      headers: requestHeaders(profile, secret),
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
    },
  };
}

function anthropicRequest(
  profile,
  secret,
  instructions,
  messages,
  tools,
  maxTokens,
  signal,
  stream = false,
) {
  const body = {
    model: profile.model,
    max_tokens: maxTokens ?? profile.maxOutputTokens,
    messages: Array.isArray(messages) ? messages : [{ role: "user", content: String(messages) }],
  };
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) {
    throw new Error("Anthropic 配置需要一个正整数的单次回复预算");
  }
  if (instructions) body.system = instructions;
  if (tools.length > 0) body.tools = tools.map(anthropicTool);
  if (stream) body.stream = true;
  return {
    url: endpoint(profile),
    init: {
      method: "POST",
      headers: {
        ...requestHeaders(profile, secret),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
    },
  };
}

function requestHeaders(profile, secret) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (profile.authMode === "x-api-key") headers["x-api-key"] = secret;
  else if (profile.authMode !== "none") headers.authorization = `Bearer ${secret}`;
  return headers;
}

function endpoint(profile) {
  const base = new URL(profile.baseURL.endsWith("/") ? profile.baseURL : `${profile.baseURL}/`);
  const resolved = new URL(profile.path, base);
  if (resolved.origin !== base.origin) {
    throw new Error("模型 API 路径不能离开配置的 baseURL");
  }
  return resolved.href;
}

async function responseBody(response) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("模型 API 返回了重定向；为避免密钥离开配置地址，Aru 没有继续请求");
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`模型 API 返回了无法读取的响应（HTTP ${response.status}）`); }
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? payload?.message ?? `模型 API 请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

async function modelResponse(response, protocol, onTextDelta) {
  if (!response.ok) {
    await responseBody(response);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const payload = await responseBody(response);
    return protocol === "anthropic-messages" ? parseAnthropic(payload) : parseOpenAI(payload);
  }
  return protocol === "anthropic-messages"
    ? streamAnthropic(response, onTextDelta)
    : streamOpenAI(response, onTextDelta);
}

async function streamOpenAI(response, onTextDelta) {
  const toolCalls = new Map();
  let content = "";
  let truncated = false;
  await consumeSSE(response, async (data) => {
    if (data === "[DONE]") return;
    const payload = parsedEvent(data);
    if (payload.error) throw new Error(payload.error.message ?? "模型 API 流式请求失败");
    if (payload?.choices?.[0]?.finish_reason === "length") truncated = true;
    const delta = payload?.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      await onTextDelta(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = Number(fragment.index ?? 0);
      const current = toolCalls.get(index) ?? {
        id: "",
        name: "",
        argumentsText: "",
      };
      if (fragment.id) current.id += String(fragment.id);
      if (fragment.function?.name) current.name += String(fragment.function.name);
      if (fragment.function?.arguments !== undefined) current.argumentsText += argumentsText(fragment.function.arguments);
      toolCalls.set(index, current);
    }
  });
  const normalizedCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
    id: call.id || `call_${randomUUID()}`,
    name: call.name,
    ...parsedArguments(call.argumentsText),
    rawArguments: call.argumentsText || "{}",
  }));
  return {
    text: "",
    toolCalls: normalizedCalls,
    truncated,
    rawMessage: {
      role: "assistant",
      content: content || null,
      tool_calls: normalizedCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.rawArguments },
      })),
    },
  };
}

async function streamAnthropic(response, onTextDelta) {
  const blocks = new Map();
  let truncated = false;
  await consumeSSE(response, async (data) => {
    const event = parsedEvent(data);
    if (event.type === "error") throw new Error(event.error?.message ?? "Anthropic 流式请求失败");
    if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") truncated = true;
    if (event.type === "content_block_start") {
      const block = event.content_block ?? {};
      blocks.set(Number(event.index ?? 0), block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, inputText: "" }
        : { type: "text", text: block.text ?? "" });
      if (block.type === "text" && block.text) await onTextDelta(block.text);
      return;
    }
    if (event.type !== "content_block_delta") return;
    const index = Number(event.index ?? 0);
    const current = blocks.get(index);
    if (!current) return;
    if (event.delta?.type === "text_delta" && current.type === "text") {
      const text = String(event.delta.text ?? "");
      current.text += text;
      if (text) await onTextDelta(text);
    }
    if (event.delta?.type === "input_json_delta" && current.type === "tool_use") {
      current.inputText += String(event.delta.partial_json ?? "");
    }
  });
  const parsedBlocks = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => {
    if (block.type === "text") return block;
    return { ...block, ...parsedArguments(block.inputText) };
  });
  // The replayed assistant turn must stay a valid tool_use block even when the
  // model's partial JSON was unreadable; the failure travels in toolCalls.
  const rawContent = parsedBlocks.map((block) => (block.type === "text"
    ? block
    : { type: "tool_use", id: block.id, name: block.name, input: block.arguments }));
  return {
    text: "",
    truncated,
    toolCalls: parsedBlocks.filter((block) => block.type === "tool_use").map((block) => ({
      id: String(block.id ?? `call_${randomUUID()}`),
      name: String(block.name ?? ""),
      arguments: block.arguments,
      argumentsError: block.argumentsError,
    })),
    rawContent,
  };
}

async function consumeSSE(response, onData) {
  if (!response.body) throw new Error("模型 API 没有返回流式响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  async function processLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        dataLines = [];
        await onData(data);
      }
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop() ?? "";
    for (const line of lines) await processLine(line);
    if (done) break;
  }
  if (buffer) await processLine(buffer);
  await processLine("");
}

function parsedEvent(data) {
  try { return JSON.parse(data); }
  catch { throw new Error("模型 API 返回了无法读取的流式事件"); }
}

function openAIHistory(history, text, attachments = []) {
  const content = [{ type: "text", text: text || attachmentPrompt(attachments) }];
  for (const attachment of attachments) {
    content.push({
      type: "image_url",
      image_url: { url: dataURL(attachment) },
    });
  }
  return [
    ...(history ?? []).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content },
  ];
}

function anthropicHistory(history, text, attachments = []) {
  const messages = (history ?? []).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user", content: message.content,
  }));
  const content = [{ type: "text", text: text || attachmentPrompt(attachments) }];
  for (const attachment of attachments) {
    const data = readFileSync(attachment.path).toString("base64");
    if (attachment.kind === "image") {
      content.push({ type: "image", source: { type: "base64", media_type: attachment.mimeType, data } });
    } else if (attachment.mimeType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: attachment.mimeType, data } });
    } else {
      content.push({ type: "text", text: `\n--- ${attachment.filename} ---\n${readFileSync(attachment.path, "utf8")}` });
    }
  }
  messages.push({ role: "user", content });
  return messages;
}

function validateDirectAttachments(profile, attachments) {
  if (!profile && attachments.length) throw new Error("这个模型 API 配置已经不存在");
  for (const attachment of attachments) {
    if (profile.protocol !== "anthropic-messages" && attachment.kind !== "image") {
      throw new Error(`这个 OpenAI-compatible 配置只能原生接收图片，不能接收 ${attachment.filename}`);
    }
    if (profile.protocol === "anthropic-messages"
        && attachment.kind !== "image"
        && attachment.mimeType !== "application/pdf"
        && !attachment.mimeType.startsWith("text/")
        && !["application/json", "application/xml"].includes(attachment.mimeType)) {
      throw new Error(`这个 Anthropic 配置不能接收 ${attachment.filename} 的文件类型`);
    }
  }
}

function attachmentPrompt(attachments) {
  return attachments.length === 1 ? `请查看附件 ${attachments[0].filename}` : "请查看这些附件";
}

function dataURL(attachment) {
  return `data:${attachment.mimeType};base64,${readFileSync(attachment.path).toString("base64")}`;
}

function parseOpenAI(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error("模型 API 没有返回 assistant message");
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: String(call.id ?? `call_${randomUUID()}`),
    name: String(call.function?.name ?? ""),
    ...parsedArguments(call.function?.arguments),
    rawArguments: argumentsText(call.function?.arguments) || "{}",
  }));
  return {
    text: contentText(message.content),
    toolCalls,
    // Replay the assistant turn with string arguments even when the relay
    // handed them over as an object; strict endpoints reject object arguments.
    rawMessage: {
      ...message,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.rawArguments },
      })),
    },
    truncated: payload.choices[0].finish_reason === "length",
  };
}

function parseAnthropic(payload) {
  if (!Array.isArray(payload?.content)) throw new Error("Anthropic API 没有返回 content blocks");
  const toolCalls = payload.content.filter((block) => block.type === "tool_use").map((block) => ({
    id: String(block.id ?? `call_${randomUUID()}`),
    name: String(block.name ?? ""),
    ...parsedArguments(block.input),
  }));
  let toolIndex = 0;
  const rawContent = payload.content.map((block) => {
    if (block.type !== "tool_use") return block;
    const call = toolCalls[toolIndex++];
    return { ...block, id: call.id, name: call.name, input: call.arguments };
  });
  return {
    text: payload.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    toolCalls,
    rawContent,
    truncated: payload.stop_reason === "max_tokens",
  };
}

function appendOpenAIToolRound(messages, result, toolResults) {
  return [
    ...messages,
    {
      role: "assistant",
      content: result.rawMessage.content ?? null,
      tool_calls: result.rawMessage.tool_calls ?? [],
    },
    ...toolResults.map((item) => ({
      role: "tool",
      tool_call_id: item.id,
      content: JSON.stringify(item.value),
    })),
  ];
}

function appendAnthropicToolRound(messages, result, toolResults) {
  return [
    ...messages,
    { role: "assistant", content: result.rawContent },
    {
      role: "user",
      content: toolResults.map((item) => ({
        type: "tool_result",
        tool_use_id: item.id,
        content: JSON.stringify(item.value),
        is_error: item.isError,
      })),
    },
  ];
}

function openAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema ?? { type: "object" },
    },
  };
}

function anthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    input_schema: tool.inputSchema ?? { type: "object" },
  };
}

// Tool arguments arrive as a JSON string (OpenAI), an accumulated stream of
// partial JSON (both protocols), or already as an object (Anthropic non-stream
// and some OpenAI-compatible relays). Empty text means "no arguments". A parse
// failure is reported, not thrown, so the turn can decide whether the model
// should retry or whether the output was cut off by the reply budget.
function parsedArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { arguments: value, argumentsError: null };
  if (value !== undefined && typeof value !== "string") {
    return { arguments: {}, argumentsError: "工具参数必须是一个 JSON object" };
  }
  const text = (value ?? "").trim();
  if (!text) return { arguments: {}, argumentsError: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { arguments: {}, argumentsError: `工具参数不是有效的 JSON（${error.message}）` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { arguments: {}, argumentsError: "工具参数必须是一个 JSON object" };
  }
  return { arguments: parsed, argumentsError: null };
}

function argumentsText(value) {
  if (value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function truncatedToolCallFailure(profile, call) {
  const budget = profile.protocol === "anthropic-messages"
    ? "请提高这个模型 API 配置的最大输出 token"
    : "这个 OpenAI-compatible 配置没有设置输出上限，截断来自接口方的默认上限，请在接口方提高上限";
  return new Error(`模型在写工具 ${call.name || "调用"} 的参数时被单次回复预算截断（max_tokens），Aru 没有执行这次调用。${budget}，或换一个模型。`);
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("");
  return "";
}

function turnKey(threadId, turnId) {
  return `${threadId}::${turnId}`;
}

function publicFailure(error, secrets = []) {
  if (error?.name === "AbortError") return "回合已中断";
  let message = String(error?.message ?? "模型 API 运行失败").trim() || "模型 API 运行失败";
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message;
}
