import React, { useState, useEffect, useRef } from "react";

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
  durationMs: number;
  timestamp: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  needsConfirmation?: boolean;
}

interface FixtureCase {
  id: string;
  label: string;
  solicitante: string;
  proveedor: string;
  monto: string;
  badge: string;
  descripcion: string;
  prompt: string;
}

interface HealthInfo {
  ok: boolean;
  provider: string;
  model: string;
  maxIterations: number;
  maxSessionTokens: number;
}

export function App() {
  const [sessionId, setSessionId] = useState<string>(() => {
    return localStorage.getItem("sap_oc_session_id") || `sesion-${Date.now()}`;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [tokensUsed, setTokensUsed] = useState<number>(0);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [fixtureCases, setFixtureCases] = useState<FixtureCase[]>([]);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Record<string, boolean>>({});
  const [showAuditModal, setShowAuditModal] = useState<boolean>(false);
  const [auditTab, setAuditTab] = useState<"orders" | "control" | "evidence">("orders");
  const [controlLog, setControlLog] = useState<string>("");
  const [sapOrders, setSapOrders] = useState<unknown[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("sap_oc_session_id", sessionId);
  }, [sessionId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking]);

  // Load health and cases
  const refreshServerData = async () => {
    try {
      const healthRes = await fetch("/api/health");
      if (healthRes.ok) {
        const hData = (await healthRes.json()) as HealthInfo;
        setHealth(hData);
      }

      const casesRes = await fetch("/api/cases");
      if (casesRes.ok) {
        const cData = (await casesRes.json()) as {
          cases: FixtureCase[];
          controlLog: string;
          sapOrders: unknown[];
        };
        setFixtureCases(cData.cases || []);
        setControlLog(cData.controlLog || "");
        setSapOrders(cData.sapOrders || []);
      }
    } catch (err) {
      console.error("Error consultando API del servidor:", err);
    }
  };

  useEffect(() => {
    refreshServerData();
  }, []);

  // Send a message
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend ?? input).trim();
    if (!text || isThinking) return;

    const userMsg: Message = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsThinking(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: text,
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        reply: string;
        toolCalls?: ToolCall[];
        needsConfirmation?: boolean;
        tokensUsed?: number;
        error?: string;
      };

      const assistantMsg: Message = {
        id: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        content: data.reply || data.error || "No se recibió respuesta.",
        timestamp: new Date().toLocaleTimeString(),
        toolCalls: data.toolCalls,
        needsConfirmation: data.needsConfirmation,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      if (typeof data.tokensUsed === "number") {
        setTokensUsed(data.tokensUsed);
      }
      refreshServerData();
    } catch (err) {
      console.error("Error enviando mensaje:", err);
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: `❌ Error de conexión con el agente: ${String(err)}`,
        timestamp: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsThinking(false);
    }
  };

  const handleResetSession = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    const newId = `sesion-${Date.now()}`;
    setSessionId(newId);
    setMessages([]);
    setTokensUsed(0);
  };

  const toggleToolCall = (id: string) => {
    setExpandedToolCalls((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const handleConfirmHumanAction = (confirmed: boolean) => {
    if (confirmed) {
      handleSendMessage("Confirmo la creación de la orden de compra con las excepciones indicadas.");
    } else {
      handleSendMessage("No confirmo. Devuelve el caso al solicitante.");
    }
  };

  // Helper to format text with markdown tables and code
  const renderFormattedContent = (content: string) => {
    const lines = content.split("\n");
    const elements: React.ReactNode[] = [];
    let inTable = false;
    let tableRows: string[][] = [];
    let tableHeaders: string[] = [];

    const flushTable = (key: number) => {
      if (inTable && tableHeaders.length > 0) {
        elements.push(
          <div key={`table-${key}`} style={{ overflowX: "auto", margin: "10px 0" }}>
            <table>
              <thead>
                <tr>
                  {tableHeaders.map((th, i) => (
                    <th key={i}>{th.trim()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx}>{cell.trim()}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        inTable = false;
        tableRows = [];
        tableHeaders = [];
      }
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const isTableRow = line.trim().startsWith("|") && line.trim().endsWith("|");

      if (isTableRow) {
        const cells = line.split("|").slice(1, -1);
        const isSeparator = cells.every((c) => /^[ -:]+$/.test(c.trim()));

        if (!inTable) {
          inTable = true;
          tableHeaders = cells;
        } else if (isSeparator) {
          // separator row, skip
        } else {
          tableRows.push(cells);
        }
      } else {
        if (inTable) {
          flushTable(idx);
        }

        if (line.trim().length === 0) {
          elements.push(<div key={`empty-${idx}`} style={{ height: "8px" }} />);
        } else if (line.startsWith("### ")) {
          elements.push(<h4 key={idx} style={{ margin: "10px 0 4px 0", color: "#60a5fa" }}>{line.replace("### ", "")}</h4>);
        } else if (line.startsWith("## ")) {
          elements.push(<h3 key={idx} style={{ margin: "12px 0 6px 0", color: "#93c5fd" }}>{line.replace("## ", "")}</h3>);
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          elements.push(
            <li key={idx} style={{ marginLeft: "18px", marginBottom: "4px" }}>
              {renderInlineBoldAndCode(line.slice(2))}
            </li>
          );
        } else {
          elements.push(
            <p key={idx} style={{ marginBottom: "6px" }}>
              {renderInlineBoldAndCode(line)}
            </p>
          );
        }
      }
    }

    if (inTable) {
      flushTable(lines.length);
    }

    return elements;
  };

  const renderInlineBoldAndCode = (text: string): React.ReactNode => {
    // Basic bold **text** and `code` splitter
    const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={i}>{part.slice(1, -1)}</code>;
      }
      return part;
    });
  };

  // Parse control.csv lines
  const parsedControlRows = controlLog
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split(","));

  return (
    <>
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-logo">P</div>
          <div className="brand-titles">
            <h1>Periferia IT Group · Agente SAP Órdenes de Compra</h1>
            <p>Automatización Inteligente de Compras & Control de Gestión</p>
          </div>
        </div>

        <div className="header-status-bar">
          <div className="badge badge-sap" title="Conexión activa con adaptador simulado SAP S/4HANA">
            <span className="dot" />
            <span>SAP S/4HANA Mock Conectado</span>
          </div>

          <div className="badge badge-model" title="Modelo de lenguaje en backend">
            <span>LLM: {health?.provider ? `${health.provider} (${health.model})` : "LangChain Auto"}</span>
          </div>

          <div className="badge badge-tokens" title="Tokens consumidos en esta sesión">
            <span>Tokens: {tokensUsed.toLocaleString()} / {(health?.maxSessionTokens ?? 100000).toLocaleString()}</span>
          </div>

          <button className="btn-header" onClick={() => setShowAuditModal(true)} title="Ver Órdenes SAP y Log de Control">
            📊 Auditoría SAP
          </button>

          <button className="btn-header btn-header-primary" onClick={handleResetSession} title="Reiniciar sesión actual">
            🔄 Nueva Sesión
          </button>
        </div>
      </header>

      {/* Quick Cases Selector Bar */}
      <div className="cases-bar">
        <span className="cases-label">Casos Rápidos:</span>

        {/* Demo Section 11 Prompt Chip */}
        <button
          className="case-chip demo-chip"
          onClick={() =>
            handleSendMessage(
              'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.'
            )
          }
          title="Ejecutar el prompt exacto de la sección 11 del PRD"
        >
          <span>⚡ Demo Oficial (sol-004)</span>
        </button>

        {fixtureCases.map((c) => (
          <button
            key={c.id}
            className="case-chip"
            onClick={() => handleSendMessage(c.prompt)}
            title={`${c.descripcion} - Monto: ${c.monto}`}
          >
            <span>{c.id}</span>
            <span className={`chip-tag ${c.badge}`}>{c.badge}</span>
          </button>
        ))}
      </div>

      {/* Main Chat Area */}
      <main className="chat-main">
        <div className="chat-messages">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🤖</div>
              <h3>Asistente Administrativo de Compras SAP</h3>
              <p>
                Puedo leer paquetes de solicitud de compra, validar maestros y controles (RC1 a RC10),
                construir payloads SAP con trazabilidad completa, generar evidencia TXT y PDF con hash SHA-256,
                y registrar órdenes en SAP con confirmación humana.
              </p>
              <p style={{ fontSize: "12px", color: "#60a5fa" }}>
                💡 Haz clic en cualquier botón de la barra superior o en <strong>"⚡ Demo Oficial (sol-004)"</strong> para comenzar.
              </p>
            </div>
          ) : (
            messages.map((msg, index) => {
              const isLastAssistant = msg.role === "assistant" && index === messages.length - 1;

              return (
                <div key={msg.id} className={`message-row ${msg.role}`}>
                  <div className={`avatar ${msg.role}-avatar`}>
                    {msg.role === "user" ? "U" : "AI"}
                  </div>

                  <div className="message-bubble">
                    {/* Tool Calls Inspector */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="tool-calls-container">
                        <div className="tool-calls-title">
                          <span>🛠️ Herramientas SAP Ejecutadas ({msg.toolCalls.length})</span>
                        </div>

                        {msg.toolCalls.map((tc) => {
                          const isExpanded = !!expandedToolCalls[tc.id];
                          const ok = tc.result.ok;
                          const resData = (tc.result.data || {}) as Record<string, unknown>;
                          const isBloqueo = resData.apta === false || (Array.isArray(resData.bloqueos) && resData.bloqueos.length > 0);
                          const isConfirm = Array.isArray(resData.confirmaciones) && resData.confirmaciones.length > 0;

                          let statusClass = "status-ok";
                          let pillText = "OK";
                          let pillClass = "ok";

                          if (!ok) {
                            statusClass = "status-bloqueo";
                            pillText = "ERROR";
                            pillClass = "error";
                          } else if (isBloqueo) {
                            statusClass = "status-bloqueo";
                            pillText = "BLOQUEO";
                            pillClass = "bloqueo";
                          } else if (isConfirm) {
                            statusClass = "status-confirmacion";
                            pillText = "CONFIRMACIÓN";
                            pillClass = "bloqueo";
                          }

                          return (
                            <div key={tc.id} className={`tool-call-card ${statusClass}`}>
                              <div className="tool-call-header">
                                <span className="tool-call-name">⚙️ {tc.name}</span>
                                <div className="tool-call-meta">
                                  <span>{tc.durationMs}ms</span>
                                  <span className={`tool-status-pill ${pillClass}`}>{pillText}</span>
                                </div>
                              </div>

                              {/* Summary info */}
                              <div className="tool-summary">
                                {Boolean(tc.args.caso) && (
                                  <span className="tool-summary-item">caso: {String(tc.args.caso)}</span>
                                )}
                                {Boolean(resData.numero_oc) && (
                                  <span className="tool-summary-item" style={{ color: "#10b981" }}>
                                    OC: {String(resData.numero_oc)}
                                  </span>
                                )}
                                {typeof resData.apta === "boolean" && (
                                  <span className="tool-summary-item">
                                    apta: {resData.apta ? "✓ Sí" : "✗ No"}
                                  </span>
                                )}
                                {Boolean(resData.retroactiva) && (
                                  <span className="tool-summary-item" style={{ color: "#ec4899" }}>
                                    retroactiva: true
                                  </span>
                                )}
                                {Boolean(resData.sha256) && (
                                  <span className="tool-summary-item">
                                    sha256: {String(resData.sha256).slice(0, 12)}...
                                  </span>
                                )}
                              </div>

                              <button
                                className="tool-expand-btn"
                                onClick={() => toggleToolCall(tc.id)}
                              >
                                {isExpanded ? "▲ Ocultar JSON detallado" : "▼ Ver argumentos y resultado (JSON)"}
                              </button>

                              {isExpanded && (
                                <pre className="tool-json-payload">
                                  {JSON.stringify(
                                    {
                                      tool: tc.name,
                                      args: tc.args,
                                      result: tc.result,
                                      durationMs: tc.durationMs,
                                      timestamp: tc.timestamp,
                                    },
                                    null,
                                    2
                                  )}
                                </pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Assistant Message Content */}
                    <div className="markdown-body">{renderFormattedContent(msg.content)}</div>

                    {/* Human Confirmation Banner (CA3 Requirement) */}
                    {msg.needsConfirmation && isLastAssistant && (
                      <div className="confirmation-banner">
                        <div className="confirmation-header">
                          <span>⚠️ Confirmación Humana Requerida</span>
                        </div>
                        <p style={{ fontSize: "12px", color: "#d1d5db" }}>
                          El agente ha detectado una o más excepciones o diferencias que requieren validación explícita
                          antes de registrar la Orden de Compra en SAP.
                        </p>
                        <div className="confirmation-actions">
                          <button
                            className="btn-confirm"
                            onClick={() => handleConfirmHumanAction(true)}
                            disabled={isThinking}
                          >
                            ✓ Confirmar y Crear OC en SAP
                          </button>
                          <button
                            className="btn-reject"
                            onClick={() => handleConfirmHumanAction(false)}
                            disabled={isThinking}
                          >
                            ✗ Rechazar y Devolver al Solicitante
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {isThinking && (
            <div className="thinking-row">
              <div className="avatar assistant-avatar">AI</div>
              <div className="thinking-box">
                <div className="spinner" />
                <span>Pensando y ejecutando herramientas SAP...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="chat-input-bar">
          <div className="input-container">
            <textarea
              className="chat-textarea"
              placeholder="Escribe una instrucción (ej. 'Procesa la solicitud sol-001' o 'Confirmo')..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              rows={1}
              disabled={isThinking}
            />
            <button
              className="btn-send"
              onClick={() => handleSendMessage()}
              disabled={!input.trim() || isThinking}
            >
              Enviar ➔
            </button>
          </div>
        </div>
      </main>

      {/* SAP Audit & Control Log Modal */}
      {showAuditModal && (
        <div className="modal-overlay" onClick={() => setShowAuditModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📊 Panel de Auditoría SAP y Log de Control</h2>
              <button className="modal-close-btn" onClick={() => setShowAuditModal(false)}>
                ✕
              </button>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab ${auditTab === "orders" ? "active" : ""}`}
                onClick={() => setAuditTab("orders")}
              >
                Órdenes SAP ({sapOrders.length})
              </button>
              <button
                className={`modal-tab ${auditTab === "control" ? "active" : ""}`}
                onClick={() => setAuditTab("control")}
              >
                Log de Control CSV
              </button>
              <button
                className={`modal-tab ${auditTab === "evidence" ? "active" : ""}`}
                onClick={() => setAuditTab("evidence")}
              >
                Evidencias Generadas
              </button>
            </div>

            <div className="modal-body">
              {auditTab === "orders" && (
                <div>
                  {sapOrders.length === 0 ? (
                    <p style={{ color: "#9ca3af", fontStyle: "italic" }}>
                      Aún no se han creado órdenes de compra en <code>out/sap/ordenes.jsonl</code>.
                    </p>
                  ) : (
                    <table className="table-audit">
                      <thead>
                        <tr>
                          <th>Nº OC</th>
                          <th>Solicitud ID</th>
                          <th>Proveedor</th>
                          <th>Moneda</th>
                          <th>Condiciones</th>
                          <th>Fecha</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sapOrders.map((ord: any, idx: number) => (
                          <tr key={idx}>
                            <td style={{ color: "#10b981", fontWeight: 700 }}>
                              {ord.numero_oc || ord.numero || "450000000X"}
                            </td>
                            <td>{ord.referencia?.solicitud_id || ord.solicitud_id || "-"}</td>
                            <td>{ord.proveedor?.nombre || ord.proveedor || "-"}</td>
                            <td>{ord.moneda || "COP"}</td>
                            <td>{ord.condiciones_pago || "-"}</td>
                            <td>{ord.fecha || ord.aprobador?.fecha_aprobacion || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {auditTab === "control" && (
                <div>
                  {parsedControlRows.length <= 1 ? (
                    <p style={{ color: "#9ca3af", fontStyle: "italic" }}>
                      Aún no hay registros en <code>out/control.csv</code>.
                    </p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="table-audit">
                        <thead>
                          <tr>
                            {parsedControlRows[0]?.map((col, cIdx) => (
                              <th key={cIdx}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {parsedControlRows.slice(1).map((row, rIdx) => {
                            const isRetroactive = row.some((c) => c.toLowerCase() === "true" || c.includes("retroactiva"));
                            return (
                              <tr key={rIdx} className={isRetroactive ? "retroactive-row" : ""}>
                                {row.map((val, vIdx) => (
                                  <td key={vIdx}>
                                    {val === "true" && isRetroactive ? (
                                      <span className="retro-badge">RETROACTIVA</span>
                                    ) : (
                                      val
                                    )}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {auditTab === "evidence" && (
                <div>
                  <p style={{ fontSize: "13px", color: "#9ca3af", marginBottom: "14px" }}>
                    Archivos de evidencia y trazabilidad disponibles en <code>out/</code>:
                  </p>
                  <table className="table-audit">
                    <thead>
                      <tr>
                        <th>Caso</th>
                        <th>Evidencia TXT (P0)</th>
                        <th>Evidencia PDF (P1)</th>
                        <th>Trazabilidad JSON</th>
                      </tr>
                    </thead>
                    <tbody>
                      {["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"].map((caso) => (
                        <tr key={caso}>
                          <td style={{ fontWeight: 600 }}>{caso}</td>
                          <td>
                            <a href={`/out/${caso}/aprobacion.txt`} target="_blank" rel="noreferrer" className="evidence-link">
                              📄 aprobacion.txt
                            </a>
                          </td>
                          <td>
                            <a href={`/out/${caso}/aprobacion.pdf`} target="_blank" rel="noreferrer" className="evidence-link">
                              📑 aprobacion.pdf
                            </a>
                          </td>
                          <td>
                            <a href={`/out/${caso}/trazabilidad.json`} target="_blank" rel="noreferrer" className="evidence-link">
                              🔍 trazabilidad.json
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
