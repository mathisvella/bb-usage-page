import type { LiveStatus } from "../../lib/live-status";

function money(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function capacity(value: number | null): string {
  return value === null ? "—" : `${(value / 1024 ** 3).toFixed(1)} Gio`;
}

function resetDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null :
    new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function statusText(status: "not_connected" | "expired" | "error", message: string | null): string {
  if (message) return message;
  return status === "not_connected" ? "Connexion à terminer." :
    status === "expired" ? "Connexion expirée." : "Mesure indisponible.";
}

function RemainingBar({ label, remainingPercent, detail }: {
  label: string;
  remainingPercent: number;
  detail?: string | null;
}) {
  const amount = Math.max(0, Math.min(100, remainingPercent));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">{Math.round(amount)} % libres</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${amount}%` }} />
      </div>
      {detail ? <p className="text-[11px] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function Card({ title, mark, children }: {
  title: string;
  mark: string;
  children: React.ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-border bg-background p-4">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold">
          {mark}
        </span>
        {title}
      </h3>
      {children}
    </article>
  );
}

export function LiveStatusSection({ status, error }: {
  status: LiveStatus | null;
  error: string | null;
}) {
  return (
    <section className="space-y-3" aria-label="Comptes et capacité du VPS">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Comptes et VPS</h2>
        {status ? <span className="text-[11px] text-muted-foreground">
          Actualisé à {new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(status.observedAt))}
        </span> : null}
      </div>
      {error ? <p className="text-xs text-destructive">Mesures indisponibles : {error}</p> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Claude · compte 2" mark="C₂">
          {!status ? <p className="text-xs text-muted-foreground">Chargement…</p> :
            status.claudeSecond.status !== "ok" ?
              <p className="text-xs text-muted-foreground">{statusText(status.claudeSecond.status, status.claudeSecond.message)}</p> :
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {[status.claudeSecond.accountEmail, status.claudeSecond.planLabel].filter(Boolean).join(" · ")}
                </p>
                {status.claudeSecond.windows.length === 0 ?
                  <p className="text-xs text-muted-foreground">Aucune limite communiquée par Claude.</p> :
                  status.claudeSecond.windows.map((window) => (
                    <RemainingBar
                      key={window.label}
                      label={window.label}
                      remainingPercent={100 - window.usedPercent}
                      detail={resetDate(window.resetsAt) ? `Réinitialisation le ${resetDate(window.resetsAt)}` : null}
                    />
                  ))}
              </div>}
        </Card>

        <Card title="OpenRouter" mark="OR">
          {!status ? <p className="text-xs text-muted-foreground">Chargement…</p> :
            status.openRouter.status !== "ok" ?
              <p className="text-xs text-muted-foreground">{statusText(status.openRouter.status, status.openRouter.message)}</p> :
              <div className="space-y-3">
                <div>
                  <p className="text-2xl font-semibold text-foreground tabular-nums">{money(status.openRouter.spentUsdMonth)}</p>
                  <p className="text-xs text-muted-foreground">dépensés ce mois</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Aujourd’hui</p><p className="tabular-nums text-foreground">{money(status.openRouter.spentUsdToday)}</p></div>
                  <div><p className="text-muted-foreground">Semaine</p><p className="tabular-nums text-foreground">{money(status.openRouter.spentUsdWeek)}</p></div>
                  <div><p className="text-muted-foreground">Total</p><p className="tabular-nums text-foreground">{money(status.openRouter.spentUsdTotal)}</p></div>
                </div>
                {status.openRouter.keyRemainingUsd !== null && status.openRouter.keyLimitUsd !== null ?
                  <p className="text-xs text-muted-foreground">
                    {money(status.openRouter.keyRemainingUsd)} disponibles sur la limite de {money(status.openRouter.keyLimitUsd)}
                  </p> :
                  <p className="text-[11px] text-muted-foreground">Aucun plafond défini pour cette clé.</p>}
              </div>}
        </Card>

        <Card title="VPS Mathis" mark="VPS">
          {!status ? <p className="text-xs text-muted-foreground">Chargement…</p> :
            status.vps.status !== "ok" ?
              <p className="text-xs text-muted-foreground">{status.vps.message ?? "Mesure indisponible."}</p> :
              <div className="space-y-3">
                {status.vps.diskTotalBytes && status.vps.diskFreeBytes !== null ?
                  <RemainingBar label="Disque" remainingPercent={100 * status.vps.diskFreeBytes / status.vps.diskTotalBytes}
                    detail={`${capacity(status.vps.diskFreeBytes)} disponibles sur ${capacity(status.vps.diskTotalBytes)}`} /> : null}
                {status.vps.memoryTotalBytes && status.vps.memoryAvailableBytes !== null ?
                  <RemainingBar label="Mémoire" remainingPercent={100 * status.vps.memoryAvailableBytes / status.vps.memoryTotalBytes}
                    detail={`${capacity(status.vps.memoryAvailableBytes)} disponibles sur ${capacity(status.vps.memoryTotalBytes)}`} /> : null}
                {status.vps.cpuUsedPercent !== null ?
                  <RemainingBar label="CPU maintenant" remainingPercent={100 - status.vps.cpuUsedPercent} /> : null}
              </div>}
        </Card>
      </div>
    </section>
  );
}
