// AI SDR Kit MCP server. No account needed.
//
// It answers initialize, tools/list and the two free tools (the outbound SOP
// and the sequence playbook) itself. The list also shows Zevari's tools; calling
// one replies with how to add Zevari (mcp.zevari.ai/mcp) and sign in there.
// /free is kept as an alias of /mcp.
//
// Every call is counted (method, tool, the AI app, outcome) so kit traffic is
// visible on its own. Tool arguments are never recorded.

interface Env {
  KIT_CALLS?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };

const ZEVARI_MCP = "https://mcp.zevari.ai";
const GUIDES = "https://zevari.ai/guides";
const VERSION = "0.1.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const FREE_TOOLS = [
  {
    name: "get_outbound_sop",
    file: "agentify-outbound-sop.md",
    description:
      "The outbound operating procedure for your AI: standing orders, the trust ladder and eight phases from connecting Zevari to autopilot. Free, no account needed. Save it and follow it from Phase 1.",
  },
  {
    name: "get_sequence_playbook",
    file: "outbound-sequence-playbook.md",
    description:
      "The outbound sequence playbook: how to score and route each lead, and every LinkedIn and email sequence step by step, with campaign JSON. Free, no account needed.",
  },
];

const DIRECTOR = {
  name: "sales_director_get",
  description: "The AI Sales Director: what to run next across your outbound, with plays you approve. Needs a Zevari account.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

const INSTRUCTIONS =
  "AI SDR Kit by Zevari, the SDR harness for your AI. Your AI is the brain; Zevari teaches it how to run outbound. " +
  "Free without an account: `get_outbound_sop` (the operating procedure) and `get_sequence_playbook` (lead routing and every sequence). " +
  "The other tools (the AI Sales Director, automations, LinkedIn and email sending) need a Zevari account: add https://mcp.zevari.ai/mcp as a connector and sign in.";

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path !== "/mcp" && path !== "/free") {
      return path === "/" ? Response.redirect("https://github.com/zevarihq/ai-sdr-kit", 302) : new Response("Not found", { status: 404 });
    }

    const calls = request.method === "POST" ? await readRpc(request) : [];
    const track = (outcome: string, status: number) => {
      for (const call of calls.length ? calls : [{ method: request.method } as Rpc]) {
        record(env, request, call, outcome, status);
      }
    };

    if (request.method !== "POST") {
      track("method_not_allowed", 405);
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!calls.length) {
      track("bad_request", 400);
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const replies = [];
    for (const call of calls) {
      const reply = await answer(call);
      if (reply) replies.push(reply);
    }
    const needsAccount = calls.some((c) => c.method === "tools/call" && !isFree(c.params?.name));
    track(needsAccount ? "needs_account" : "answered", replies.length ? 200 : 202);
    if (!replies.length) return new Response(null, { status: 202 });
    return json(replies.length > 1 ? replies : replies[0]);
  },
};

function isFree(name: unknown) {
  return FREE_TOOLS.some((t) => t.name === name);
}

async function answer(call: Rpc): Promise<object | null> {
  if (call.id === undefined || call.id === null) return null; // notification
  switch (call.method) {
    case "initialize": {
      const asked = call.params?.protocolVersion;
      return rpcResult(call.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "ai-sdr-kit", title: "AI SDR Kit by Zevari", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(call.id, {});
    case "tools/list":
      return rpcResult(call.id, { tools: [...FREE_TOOLS.map(freeToolDef), ...(await zevariTools())] });
    case "tools/call": {
      const tool = FREE_TOOLS.find((t) => t.name === call.params?.name);
      if (!tool) {
        return rpcResult(call.id, {
          isError: true,
          content: [{ type: "text", text: "This tool needs a Zevari account. Add https://mcp.zevari.ai/mcp as a connector (or MCP server) and sign in, then call it there." }],
        });
      }
      const res = await fetch(`${GUIDES}/${tool.file}`, { cf: { cacheTtl: 3600 } } as RequestInit);
      if (!res.ok) return rpcResult(call.id, { isError: true, content: [{ type: "text", text: "The guide is unavailable right now. Try again shortly." }] });
      return rpcResult(call.id, { content: [{ type: "text", text: await res.text() }] });
    }
    default:
      return rpcError(call.id, -32601, `Method not found: ${call.method}`);
  }
}

function freeToolDef(t: (typeof FREE_TOOLS)[number]) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

// The rest of the list is Zevari's public tool card, so an AI can see what
// signing in unlocks.
async function zevariTools(): Promise<object[]> {
  try {
    const res = await fetch(`${ZEVARI_MCP}/.well-known/mcp/server-card.json`, { cf: { cacheTtl: 3600 } } as RequestInit);
    if (!res.ok) return [];
    const card = (await res.json()) as { tools?: { name?: string }[] };
    const tools = card.tools ?? [];
    // The public card leaves out the Director (it ships with Automations), so
    // name it here: asking for it should reach the "sign in" reply.
    if (!tools.some((t) => t.name === "sales_director_get")) tools.unshift(DIRECTOR);
    return tools;
  } catch {
    return [];
  }
}

async function readRpc(request: Request): Promise<Rpc[]> {
  try {
    const body = await request.clone().json();
    const list = Array.isArray(body) ? body : [body];
    return list.filter((c) => c && typeof c === "object");
  } catch {
    return [];
  }
}

function record(env: Env, request: Request, call: Rpc, outcome: string, status: number) {
  const client = call.method === "initialize" ? call.params?.clientInfo ?? {} : {};
  const tool = call.method === "tools/call" ? String(call.params?.name ?? "") : "";
  try {
    env.KIT_CALLS?.writeDataPoint({
      indexes: [String(call.method ?? "")],
      blobs: [
        String(call.method ?? ""),
        tool,
        "free",
        String(client.name ?? "").slice(0, 100),
        String(client.version ?? "").slice(0, 50),
        outcome,
        (request.headers.get("user-agent") ?? "").slice(0, 200),
        new URL(request.url).host,
      ],
      doubles: [status],
    });
  } catch {
    // Counting must never change a call's outcome.
  }
}

function rpcResult(id: Rpc["id"], result: object) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
