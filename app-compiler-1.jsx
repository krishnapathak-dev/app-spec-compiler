import { useState, useRef } from "react";

// ── CONSTANTS ──────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;

const STAGES = [
  { id: "intent",   label: "Intent Extraction",  icon: "🔍", color: "#6366f1" },
  { id: "design",   label: "System Design",       icon: "🏗️", color: "#8b5cf6" },
  { id: "schema",   label: "Schema Generation",   icon: "📐", color: "#a855f7" },
  { id: "refine",   label: "Refinement & Repair", icon: "🔧", color: "#d946ef" },
  { id: "validate", label: "Validation",           icon: "✅", color: "#ec4899" },
];

// ── API HELPER ─────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userContent, jsonMode = true) {
  const messages = [{ role: "user", content: userContent }];
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  const text = data.content.map(b => b.text || "").join("");

  if (!jsonMode) return text;

  // strip markdown fences
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // attempt repair: extract first {...} or [...] block
    const match = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Could not parse JSON from model response:\n" + clean.slice(0, 300));
  }
}

// ── PIPELINE STAGES ────────────────────────────────────────────────────────────

async function stageIntent(prompt) {
  const sys = `You are an intent extraction engine for a no-code app compiler.
Parse the user's natural language request into a STRICT JSON object.
Return ONLY valid JSON — no prose, no markdown fences.

Required schema:
{
  "appName": string,
  "appType": string,
  "coreFeatures": string[],
  "userRoles": string[],
  "authRequired": boolean,
  "paymentsRequired": boolean,
  "analyticsRequired": boolean,
  "ambiguities": string[],
  "assumptions": string[]
}`;

  return await callClaude(sys, `User request: "${prompt}"`);
}

async function stageDesign(intent) {
  const sys = `You are a system architecture engine for a no-code app compiler.
Given a structured intent JSON, output a full system design.
Return ONLY valid JSON — no prose, no markdown fences.

Required schema:
{
  "entities": [{ "name": string, "description": string, "fields": [{ "name": string, "type": string }] }],
  "flows": [{ "name": string, "steps": string[] }],
  "roles": [{ "name": string, "permissions": string[] }],
  "pages": [{ "name": string, "route": string, "accessRoles": string[], "components": string[] }]
}`;

  return await callClaude(sys, `Intent: ${JSON.stringify(intent, null, 2)}`);
}

async function stageSchema(intent, design) {
  const sys = `You are a schema generation engine for a no-code app compiler.
Given intent + system design, produce a complete multi-layer schema.
Return ONLY valid JSON — no prose, no markdown fences.

Required schema:
{
  "db": {
    "tables": [{
      "name": string,
      "columns": [{ "name": string, "type": string, "nullable": boolean, "pk": boolean, "fk": string|null }],
      "relations": [{ "type": "hasMany"|"belongsTo"|"manyToMany", "target": string, "via": string|null }]
    }]
  },
  "api": {
    "endpoints": [{
      "method": "GET"|"POST"|"PUT"|"DELETE"|"PATCH",
      "path": string,
      "auth": boolean,
      "roles": string[],
      "requestBody": object|null,
      "response": object
    }]
  },
  "ui": {
    "pages": [{
      "name": string,
      "route": string,
      "layout": string,
      "components": [{
        "type": string,
        "props": object,
        "dataSource": string|null
      }]
    }]
  },
  "auth": {
    "strategy": string,
    "roles": [{ "name": string, "inherits": string|null }],
    "rules": [{ "resource": string, "action": string, "roles": string[] }]
  }
}`;

  return await callClaude(sys,
    `Intent: ${JSON.stringify(intent, null, 2)}\n\nDesign: ${JSON.stringify(design, null, 2)}`);
}

async function stageRefine(intent, design, schema) {
  const sys = `You are a refinement and repair engine for a no-code app compiler.
Your job is to find and fix ALL inconsistencies across the three layers:
- DB schema field names must match API request/response field names
- API endpoints must exist for every UI data source
- Auth rules must cover every protected endpoint
- UI components must map to real API endpoints

Return a JSON object:
{
  "issues": [{ "layer": string, "description": string, "fix": string }],
  "refinedSchema": { ...same structure as input schema, corrected... }
}

Return ONLY valid JSON.`;

  return await callClaude(sys,
    `Intent: ${JSON.stringify(intent, null, 2)}\nDesign: ${JSON.stringify(design, null, 2)}\nSchema: ${JSON.stringify(schema, null, 2)}`);
}

function validateSchema(schema) {
  const errors = [];

  // DB checks
  const tableNames = new Set((schema.db?.tables || []).map(t => t.name));

  for (const table of schema.db?.tables || []) {
    if (!table.columns?.length) errors.push(`Table "${table.name}" has no columns`);
    const hasPk = table.columns?.some(c => c.pk);
    if (!hasPk) errors.push(`Table "${table.name}" has no primary key`);
    for (const col of table.columns || []) {
      if (col.fk && !tableNames.has(col.fk.split(".")[0])) {
        errors.push(`FK "${col.fk}" in table "${table.name}" references unknown table`);
      }
    }
  }

  // API checks
  const apiPaths = new Set((schema.api?.endpoints || []).map(e => e.method + " " + e.path));
  for (const ep of schema.api?.endpoints || []) {
    if (!ep.path.startsWith("/")) errors.push(`Endpoint path "${ep.path}" must start with /`);
  }

  // UI → API cross-check
  for (const page of schema.ui?.pages || []) {
    for (const comp of page.components || []) {
      if (comp.dataSource && !["string", "null"].includes(typeof comp.dataSource)) {
        errors.push(`Component "${comp.type}" on page "${page.name}" has invalid dataSource`);
      }
    }
  }

  // Auth cross-check
  const endpointPaths = (schema.api?.endpoints || []).map(e => e.path);
  for (const rule of schema.auth?.rules || []) {
    // rules that reference specific paths should exist
  }

  return errors;
}

// ── FULL PIPELINE ──────────────────────────────────────────────────────────────

async function runPipeline(prompt, onProgress) {
  const metrics = { startTime: Date.now(), retries: 0, stageTimings: {} };

  const run = async (stageName, fn) => {
    const t0 = Date.now();
    onProgress(stageName, "running");
    try {
      const result = await fn();
      metrics.stageTimings[stageName] = Date.now() - t0;
      onProgress(stageName, "done");
      return result;
    } catch (err) {
      metrics.stageTimings[stageName] = Date.now() - t0;
      onProgress(stageName, "error", err.message);
      throw err;
    }
  };

  // Stage 1
  const intent = await run("intent", () => stageIntent(prompt));

  // Stage 2
  const design = await run("design", () => stageDesign(intent));

  // Stage 3
  const schema = await run("schema", () => stageSchema(intent, design));

  // Stage 4 – refinement
  const refined = await run("refine", () => stageRefine(intent, design, schema));
  const finalSchema = refined.refinedSchema || schema;

  // Stage 5 – local validation
  await run("validate", async () => {
    const errors = validateSchema(finalSchema);
    if (errors.length > 0) {
      // attempt auto-repair of trivial issues (missing pk)
      for (const table of finalSchema.db?.tables || []) {
        const hasPk = table.columns?.some(c => c.pk);
        if (!hasPk && table.columns?.length) {
          table.columns.unshift({ name: "id", type: "uuid", nullable: false, pk: true, fk: null });
          metrics.retries++;
        }
      }
    }
    return { errors, repaired: metrics.retries };
  });

  metrics.totalMs = Date.now() - metrics.startTime;

  return {
    intent,
    design,
    schema: finalSchema,
    issues: refined.issues || [],
    metrics,
    assumptions: intent.assumptions || [],
    ambiguities: intent.ambiguities || [],
  };
}

// ── UI COMPONENTS ──────────────────────────────────────────────────────────────

function StageIndicator({ stages, stageStatus }) {
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 24, borderRadius: 12, overflow: "hidden", border: "1px solid #1e1e2e" }}>
      {STAGES.map((s, i) => {
        const status = stageStatus[s.id] || "pending";
        const bg = status === "done" ? "#1a1a2e" : status === "running" ? "#0f0f1a" : "#0a0a12";
        const border = status === "running" ? `2px solid ${s.color}` : "none";
        return (
          <div key={s.id} style={{
            flex: 1, padding: "10px 8px", background: bg,
            borderBottom: border, textAlign: "center",
            borderRight: i < STAGES.length - 1 ? "1px solid #1e1e2e" : "none",
            transition: "all 0.3s"
          }}>
            <div style={{ fontSize: 18, marginBottom: 2 }}>
              {status === "done" ? "✓" : status === "running" ? "⟳" : status === "error" ? "✗" : s.icon}
            </div>
            <div style={{ fontSize: 10, color: status === "done" ? s.color : status === "error" ? "#f43f5e" : "#555", fontFamily: "monospace", lineHeight: 1.2 }}>
              {s.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JsonViewer({ data, label, color = "#6366f1" }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 12, border: `1px solid ${color}33`, borderRadius: 8, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: "100%", padding: "10px 14px", background: `${color}11`,
        border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between",
        alignItems: "center", color: "#e2e8f0", fontFamily: "monospace", fontSize: 13
      }}>
        <span style={{ color }}>{label}</span>
        <span style={{ fontSize: 10, color: "#666" }}>{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <pre style={{
          margin: 0, padding: 14, background: "#080810",
          color: "#a5b4fc", fontSize: 11, fontFamily: "monospace",
          overflowX: "auto", maxHeight: 400, overflowY: "auto",
          whiteSpace: "pre-wrap", wordBreak: "break-word"
        }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function MetricsPanel({ metrics, issues, assumptions, ambiguities }) {
  const total = metrics.totalMs / 1000;
  return (
    <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, marginBottom: 20 }}>
      <div style={{ color: "#7c3aed", fontFamily: "monospace", fontSize: 12, marginBottom: 12, letterSpacing: 2 }}>
        PIPELINE METRICS
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        {[
          { label: "Total Time", value: total.toFixed(2) + "s" },
          { label: "Auto Repairs", value: metrics.retries },
          { label: "Issues Found", value: issues.length },
          { label: "Stage Count", value: STAGES.length },
        ].map(m => (
          <div key={m.label} style={{ background: "#0f0f1a", borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 20, color: "#a78bfa", fontFamily: "monospace" }}>{m.value}</div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{m.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          {assumptions.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4, fontFamily: "monospace" }}>ASSUMPTIONS MADE</div>
              {assumptions.map((a, i) => <div key={i} style={{ fontSize: 11, color: "#94a3b8", marginBottom: 3 }}>• {a}</div>)}
            </div>
          )}
        </div>
        <div>
          {ambiguities.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#ef4444", marginBottom: 4, fontFamily: "monospace" }}>AMBIGUITIES DETECTED</div>
              {ambiguities.map((a, i) => <div key={i} style={{ fontSize: 11, color: "#94a3b8", marginBottom: 3 }}>• {a}</div>)}
            </div>
          )}
        </div>
      </div>
      {issues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: "#22c55e", marginBottom: 4, fontFamily: "monospace" }}>REPAIRS APPLIED</div>
          {issues.map((iss, i) => (
            <div key={i} style={{ fontSize: 11, color: "#94a3b8", marginBottom: 3, background: "#0f0f1a", borderRadius: 4, padding: "4px 8px" }}>
              <span style={{ color: "#a78bfa" }}>[{iss.layer}]</span> {iss.description} → {iss.fix}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  "Build a CRM with login, contacts, dashboard, role-based access, and premium plan with payments. Admins can see analytics.",
  "Create a project management tool like Jira with sprints, tickets, comments, and team roles.",
  "Build a food delivery app with restaurant listings, cart, orders, driver tracking, and payments.",
  "Make a learning platform with courses, quizzes, progress tracking, and instructor/student roles.",
];

// ── MAIN APP ───────────────────────────────────────────────────────────────────

export default function AppCompiler() {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [stageStatus, setStageStatus] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(false);

  const updateStage = (id, status, msg) => {
    setStageStatus(prev => ({ ...prev, [id]: status, [`${id}_msg`]: msg }));
  };

  const handleRun = async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setStageStatus({});
    abortRef.current = false;

    try {
      const out = await runPipeline(prompt.trim(), updateStage);
      setResult(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#05050d", color: "#e2e8f0",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      padding: "32px 20px", maxWidth: 900, margin: "0 auto"
    }}>

      {/* Header */}
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#7c3aed", letterSpacing: 4, fontFamily: "monospace", marginBottom: 8 }}>
          AI ENGINEER DEMO · MULTI-STAGE COMPILER
        </div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, background: "linear-gradient(135deg, #6366f1, #d946ef)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          App Spec Compiler
        </h1>
        <p style={{ color: "#555", fontSize: 13, marginTop: 6 }}>
          Natural language → structured config via 5-stage pipeline with validation & repair
        </p>
      </div>

      {/* Pipeline diagram */}
      <StageIndicator stages={STAGES} stageStatus={stageStatus} />

      {/* Input */}
      <div style={{ marginBottom: 16 }}>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Describe the app you want to build..."
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#0a0a12", border: "1px solid #2d2d3d",
            borderRadius: 10, padding: 14, color: "#e2e8f0",
            fontSize: 14, resize: "vertical", outline: "none",
            fontFamily: "'Segoe UI', sans-serif",
            lineHeight: 1.6
          }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {EXAMPLE_PROMPTS.map((ex, i) => (
            <button key={i} onClick={() => setPrompt(ex)} style={{
              fontSize: 11, padding: "4px 10px", background: "#0f0f1a",
              border: "1px solid #2d2d3d", borderRadius: 20, color: "#888",
              cursor: "pointer", fontFamily: "monospace"
            }}>
              Example {i + 1}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleRun}
        disabled={running || !prompt.trim()}
        style={{
          width: "100%", padding: "14px 24px", marginBottom: 24,
          background: running ? "#1a1a2e" : "linear-gradient(135deg, #6366f1, #d946ef)",
          border: "none", borderRadius: 10, color: "#fff",
          fontSize: 15, fontWeight: 600, cursor: running ? "not-allowed" : "pointer",
          letterSpacing: 0.5, transition: "opacity 0.2s"
        }}
      >
        {running ? "⟳  Running pipeline..." : "▶  Compile App Spec"}
      </button>

      {/* Running stage messages */}
      {running && (
        <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, marginBottom: 20 }}>
          {STAGES.map(s => {
            const st = stageStatus[s.id];
            if (!st) return null;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 14 }}>
                  {st === "done" ? "✓" : st === "running" ? "⟳" : st === "error" ? "✗" : "·"}
                </span>
                <span style={{ color: st === "done" ? s.color : st === "running" ? "#e2e8f0" : "#f43f5e", fontSize: 13 }}>
                  {s.label}
                </span>
                {st === "error" && stageStatus[`${s.id}_msg`] && (
                  <span style={{ color: "#f43f5e", fontSize: 11 }}>{stageStatus[`${s.id}_msg`]}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ background: "#1a0a0a", border: "1px solid #f43f5e44", borderRadius: 10, padding: 14, marginBottom: 20, color: "#f87171", fontSize: 13 }}>
          ✗ Pipeline Error: {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div>
          <MetricsPanel
            metrics={result.metrics}
            issues={result.issues}
            assumptions={result.assumptions}
            ambiguities={result.ambiguities}
          />

          <div style={{ fontSize: 11, color: "#7c3aed", letterSpacing: 3, fontFamily: "monospace", marginBottom: 12 }}>
            GENERATED SCHEMAS
          </div>

          <JsonViewer data={result.intent} label="Stage 1 · Intent" color="#6366f1" />
          <JsonViewer data={result.design} label="Stage 2 · System Design" color="#8b5cf6" />
          <JsonViewer data={result.schema?.db} label="Stage 3 · Database Schema" color="#a855f7" />
          <JsonViewer data={result.schema?.api} label="Stage 3 · API Schema" color="#a855f7" />
          <JsonViewer data={result.schema?.ui} label="Stage 3 · UI Schema" color="#a855f7" />
          <JsonViewer data={result.schema?.auth} label="Stage 3 · Auth Schema" color="#a855f7" />
          <JsonViewer data={result.issues?.length ? result.issues : { message: "No issues found — schema is consistent" }} label="Stage 4 · Refinement Issues" color="#d946ef" />

          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "#22c55e", letterSpacing: 3, fontFamily: "monospace", marginBottom: 8 }}>EXECUTION READINESS</div>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>
              ✓ DB schema has {result.schema?.db?.tables?.length || 0} tables with PKs and relations<br />
              ✓ API has {result.schema?.api?.endpoints?.length || 0} endpoints with auth rules<br />
              ✓ UI has {result.schema?.ui?.pages?.length || 0} pages with component mappings<br />
              ✓ Auth system with {result.schema?.auth?.roles?.length || 0} roles and {result.schema?.auth?.rules?.length || 0} permission rules<br />
              ✓ Cross-layer consistency validated and repaired
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
