const allowedOrigin = process.env.ALLOWED_ORIGIN || "https://raddadd.github.io";
const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin"
};

function json(body, status = 200, extraHeaders = {}) {
    return Response.json(body, { status, headers: { ...corsHeaders, ...extraHeaders } });
}

async function readLimitedBody(request, maxBytes) {
    const reader = request.body?.getReader();
    if (!reader) return "";
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error("body-too-large");
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    );
}

export default {
    async fetch(request) {
        // Origin checks limit browser access; they are not authentication or rate limiting.
        if (request.headers.get("origin") !== allowedOrigin) {
            return json({ error: "Forbidden" }, 403, { "Access-Control-Allow-Origin": "null" });
        }
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST, OPTIONS" });
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
            return json({ error: "Expected JSON" }, 415);
        }
        if (!process.env.GEMINI_API_KEY) return json({ error: "Chat is not configured" }, 503);

        let messages;
        try {
            const body = JSON.parse(await readLimitedBody(request, 8192));
            messages = body.messages;
            if (!Array.isArray(messages) || messages.length < 1 || messages.length > 8 ||
                !messages.every(m => m && ["user", "assistant"].includes(m.role) &&
                    typeof m.content === "string" && m.content.trim() && m.content.length <= 1200) ||
                messages.at(-1).role !== "user" ||
                messages.reduce((total, m) => total + m.content.length, 0) > 6000) {
                return json({ error: "Invalid messages" }, 400);
            }
        } catch {
            return json({ error: "Invalid or oversized JSON" }, 400);
        }

        try {
            // Gemini expects conversations to begin with a user turn. The browser
            // retains eight messages, which can otherwise start with an assistant.
            while (messages[0]?.role === "assistant") messages.shift();
            const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent", {
                method: "POST",
                headers: {
                    "x-goog-api-key": process.env.GEMINI_API_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: "You are a concise, friendly assistant on RadDadd's Data Tree, a personal site for Dale's data and technology projects. Answer questions conversationally. You can describe this page as a place to share data projects and experiments. Do not invent details about projects or claim access to private data or live news." }] },
                    contents: messages.map(m => ({
                        role: m.role === "assistant" ? "model" : "user",
                        parts: [{ text: m.content }]
                    })),
                    generationConfig: { maxOutputTokens: 500, thinkingConfig: { thinkingLevel: "minimal" } }
                }),
                signal: AbortSignal.timeout(20000)
            });
            if (!upstream.ok) {
                const errorData = await upstream.json().catch(() => ({}));
                const providerMessage = String(errorData.error?.message || "No provider details")
                    .replaceAll(process.env.GEMINI_API_KEY, "[redacted]").slice(0, 300);
                console.error("Gemini request failed", upstream.status, providerMessage);
                return json({ error: "Chat service unavailable" }, upstream.status === 429 ? 429 : 502);
            }
            const data = await upstream.json();
            const reply = data.candidates?.[0]?.content?.parts
                ?.filter(part => typeof part.text === "string" && !part.thought)
                .map(part => part.text)
                .join("\n")
                .trim();
            if (!reply) return json({ error: "Empty response" }, 502);
            return json({ reply });
        } catch (error) {
            console.error("Chat request failed", error?.name || "Error");
            return json({ error: "Chat service unavailable" }, 502);
        }
    }
};
