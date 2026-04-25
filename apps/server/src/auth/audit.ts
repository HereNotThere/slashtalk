type AuthAuditData = Record<string, string | number | boolean | null>;

export function authAudit(event: string, data: AuthAuditData = {}): void {
  const line = JSON.stringify({
    level: "info",
    msg: "auth_audit",
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  process.stderr.write(`${line}\n`);
}
