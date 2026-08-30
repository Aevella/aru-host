import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
        if (!secret) throw new Error("这个模型 API 配置缺少钥匙串密钥");
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
    if (!secret) throw new Error("API key is missing from the operating-system secret store");
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
      completedToolRounds += 1;
      const toolResults = [];
      for (const call of result.toolCalls) {
        const item = { id: call.id, type: "dynamicToolCall", tool: call.name };
        await handler.onNotification("item/started", { threadId, turnId, item });
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
  await consumeSSE(response, async (data) => {
    if (data === "[DONE]") return;
    const payload = parsedEvent(data);
    if (payload.error) throw new Error(payload.error.message ?? "模型 API 流式请求失败");
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
      if (fragment.function?.arguments) current.argumentsText += String(fragment.function.arguments);
      toolCalls.set(index, current);
    }
  });
  const normalizedCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
    id: call.id || `call_${randomUUID()}`,
    name: call.name,
    arguments: parsedArguments(call.argumentsText),
    rawArguments: call.argumentsText || "{}",
  }));
  return {
    text: "",
    toolCalls: normalizedCalls,
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
  await consumeSSE(response, async (data) => {
    const event = parsedEvent(data);
    if (event.type === "error") throw new Error(event.error?.message ?? "Anthropic 流式请求失败");
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
  const rawContent = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => {
    if (block.type === "text") return block;
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: parsedArguments(block.inputText),
    };
  });
  return {
    text: "",
    toolCalls: rawContent.filter((block) => block.type === "tool_use").map((block) => ({
      id: String(block.id ?? `call_${randomUUID()}`),
      name: String(block.name ?? ""),
      arguments: block.input,
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
    arguments: parsedArguments(call.function?.arguments),
    rawArguments: String(call.function?.arguments ?? "{}"),
  }));
  return { text: contentText(message.content), toolCalls, rawMessage: message };
}

function parseAnthropic(payload) {
  if (!Array.isArray(payload?.content)) throw new Error("Anthropic API 没有返回 content blocks");
  return {
    text: payload.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    toolCalls: payload.content.filter((block) => block.type === "tool_use").map((block) => ({
      id: String(block.id ?? `call_${randomUUID()}`),
      name: String(block.name ?? ""),
      arguments: block.input && typeof block.input === "object" ? block.input : {},
    })),
    rawContent: payload.content,
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

function parsedArguments(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error("模型返回了无法读取的工具参数");
  }
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
