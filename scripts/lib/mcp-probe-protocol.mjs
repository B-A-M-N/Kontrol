const CATALOG_WRAPPERS = ["payload", "result", "toolsList", "toolsListResult", "catalog"];
const VERSION_WRAPPERS = ["payload", "result", "initialize", "initializeResult"];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

export function extractCatalog(value) {
  const locations = [];
  const visited = new Set();
  const visit = (node, path, depth = 0) => {
    if (depth > 12 || !isObject(node) || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      locations.push({ path, tools: node });
      return;
    }
    if (Array.isArray(node.tools)) locations.push({ path: `${path}.tools`, tools: node.tools });
    for (const key of CATALOG_WRAPPERS) {
      if (Object.hasOwn(node, key)) visit(node[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(value, "$root");
  if (locations.length !== 1) {
    throw new Error(`MCP catalog envelope must contain exactly one authoritative tools list; found ${locations.length}`);
  }
  const sourceTools = locations[0].tools;
  const names = sourceTools.map((tool) => typeof tool === "string" ? tool : tool?.name);
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error(`MCP catalog at ${locations[0].path} contains an item without a tool name`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`MCP catalog at ${locations[0].path} contains duplicate tool names`);
  }
  const tools = sourceTools.map((tool, index) => {
    if (typeof tool === "string") return { name: tool };
    const ui = tool?._meta?.ui;
    const resourceUri = ui?.resourceUri;
    if (resourceUri !== undefined && typeof resourceUri !== "string") {
      throw new Error(`MCP tool ${names[index]} has a non-string _meta.ui.resourceUri`);
    }
    const inputSchema = tool?.inputSchema;
    if (inputSchema !== undefined && (!isObject(inputSchema) || Array.isArray(inputSchema))) {
      throw new Error(`MCP tool ${names[index]} has a malformed inputSchema`);
    }
    const properties = inputSchema?.properties;
    if (properties !== undefined && (!isObject(properties) || Array.isArray(properties))) {
      throw new Error(`MCP tool ${names[index]} has malformed inputSchema.properties`);
    }
    const required = inputSchema?.required ?? [];
    if (!Array.isArray(required) || required.some((field) => typeof field !== "string")) {
      throw new Error(`MCP tool ${names[index]} has malformed inputSchema.required`);
    }
    return {
      name: names[index],
      ...(inputSchema !== undefined ? {
        inputFields: {
          properties: Object.keys(properties ?? {}).sort(),
          required: [...required].sort(),
          types: Object.fromEntries(Object.entries(properties ?? {}).map(([field, schema]) => [
            field,
            isObject(schema) && !Array.isArray(schema) ? schema.type ?? (schema.anyOf ? "anyOf" : schema.oneOf ? "oneOf" : undefined) : undefined,
          ]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
        },
      } : {}),
      ...(resourceUri !== undefined ? { resourceUri } : {}),
      ...(Array.isArray(ui?.visibility) ? { visibility: [...ui.visibility] } : {}),
      ...(typeof tool?._meta?.["openai/outputTemplate"] === "string"
        ? { legacyOutputTemplate: tool._meta["openai/outputTemplate"] }
        : {}),
    };
  });
  return {
    names: new Set(names),
    tools,
    version: extractServerInfoVersion(value),
    sourcePath: locations[0].path,
  };
}

/** Compare the model-visible names, required set, and basic types in each
 * input schema. Catalog names alone cannot prove that a cached host can send
 * a retry token or even supply the current required arguments. */
export function assertInputSchemaCompatibility(serverTools, hostTools, label = "host") {
  const hostByName = new Map((hostTools ?? []).map((tool) => [tool.name, tool]));
  for (const serverTool of serverTools ?? []) {
    const hostTool = hostByName.get(serverTool.name);
    if (!hostTool) continue;
    if (["bash", "exec_command", "write", "edit", "apply_patch", "read", "git_status", "git_log", "git_diff", "git_show"].includes(serverTool.name)
      && (!serverTool.inputFields?.properties.includes("approvalResumeId")
        || !hostTool.inputFields?.properties.includes("approvalResumeId"))) {
      throw new Error(`${label} catalog is missing approvalResumeId input for ${serverTool.name}`);
    }
    if (!serverTool.inputFields || !hostTool.inputFields) {
      if (serverTool.inputFields || hostTool.inputFields) {
        throw new Error(`${label} catalog input schema missing for ${serverTool.name}`);
      }
      continue;
    }
    const expected = serverTool.inputFields;
    const actual = hostTool.inputFields;
    if (JSON.stringify(expected.properties) !== JSON.stringify(actual.properties)
      || JSON.stringify(expected.required) !== JSON.stringify(actual.required)
      || JSON.stringify(expected.types) !== JSON.stringify(actual.types)) {
      throw new Error(`${label} catalog input schema mismatch for ${serverTool.name}; serverProperties=${expected.properties.join(",")}; hostProperties=${actual.properties.join(",")}; serverRequired=${expected.required.join(",")}; hostRequired=${actual.required.join(",")}`);
    }
  }
  return true;
}

export function extractWorkspaceAppResourceUris(catalog) {
  const workspaceAppUri = /^ui:\/\/(?:kontrol|devdesktop)\/workspace-app(?:-[a-f0-9]{12})?(?:\.skybridge)?\.html$/i;
  return [...new Set((catalog?.tools ?? [])
    .flatMap((tool) => [tool?.resourceUri, tool?.legacyOutputTemplate])
    .filter((uri) => typeof uri === "string" && workspaceAppUri.test(uri)))].sort();
}

export function extractServerInfoVersion(value) {
  const locations = [];
  const visited = new Set();
  const visit = (node, path, depth = 0) => {
    if (depth > 12 || !isObject(node) || visited.has(node)) return;
    visited.add(node);
    if (typeof node.serverInfo?.version === "string") {
      locations.push({ path: `${path}.serverInfo.version`, version: node.serverInfo.version });
    }
    for (const key of VERSION_WRAPPERS) {
      if (Object.hasOwn(node, key)) visit(node[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(value, "$root");
  if (locations.length > 1) {
    throw new Error(`MCP initialization envelope has ambiguous serverInfo.version fields: ${locations.map((entry) => entry.path).join(", ")}`);
  }
  return locations[0]?.version;
}

/** Parse SSE framing after transport chunks have been collected. */
export function parseSseEventChunks(chunks) {
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const lines = text.split(/\r\n|\n|\r/);
  const events = [];
  let data = [];
  let event = "message";
  const dispatch = () => {
    if (data.length > 0) events.push({ event, data: data.join("\n") });
    data = [];
    event = "message";
  };
  for (const line of lines) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  dispatch(); // SSE may terminate without a trailing blank line.
  return events;
}

export function matchJsonRpcResponse(events, expectedId) {
  const responses = [];
  let intermediateNotifications = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event.data) continue;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      throw new Error(`SSE event ${index} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (message && typeof message === "object" && message.id === expectedId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      responses.push(message);
    } else if (message && typeof message === "object" && typeof message.method === "string" && !Object.hasOwn(message, "id")) {
      intermediateNotifications++;
    } else if (message && typeof message === "object" && Object.hasOwn(message, "id")) {
      throw new Error(`SSE response ID ${String(message.id)} does not match request ID ${String(expectedId)}`);
    }
  }
  if (responses.length > 1) throw new Error(`SSE stream contained ${responses.length} responses for request ID ${String(expectedId)}`);
  return { response: responses[0], intermediateNotifications };
}
