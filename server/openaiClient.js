"use strict";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function configured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function createLogisticsBrief(input) {
  if (!configured()) throw new Error("OPENAI_API_KEY is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a logistics operations advisor for India's North Eastern Region. Analyze only the supplied route intelligence. Never invent road closures, weather, distances, or vehicle telemetry. Return JSON with exactly these keys: decision (string), confidence (number 0 to 1), reasons (array of up to 3 short strings), actions (array of up to 4 short strings), alert (string or null). The decision must be one of: PROCEED, PROCEED_WITH_CAUTION, USE_ALTERNATE, HOLD_AND_VERIFY. Prefer concrete operational guidance for essential-goods transport. Mention uncertainty when hazard data is degraded or the input is demo data."
          },
          {
            role: "user",
            content: JSON.stringify(input)
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no brief");
    const brief = JSON.parse(content);
    return normalizeBrief(brief);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBrief(brief) {
  const decisions = new Set(["PROCEED", "PROCEED_WITH_CAUTION", "USE_ALTERNATE", "HOLD_AND_VERIFY"]);
  return {
    decision: decisions.has(brief.decision) ? brief.decision : "PROCEED_WITH_CAUTION",
    confidence: Math.max(0, Math.min(1, Number(brief.confidence) || 0)),
    reasons: Array.isArray(brief.reasons) ? brief.reasons.slice(0, 3).map(String) : [],
    actions: Array.isArray(brief.actions) ? brief.actions.slice(0, 4).map(String) : [],
    alert: brief.alert ? String(brief.alert).slice(0, 240) : null
  };
}

module.exports = { configured, createLogisticsBrief };
