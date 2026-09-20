import { useMemo } from "react";

export type PullRequestActivity = {
  login: string;
  days: Array<{ day: string; count: number }>;
  total: number;
  incomplete: boolean;
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

type Cell = { key: string; day?: string; count?: number; level?: number };

function levelFor(count: number, peak: number): number {
  if (count === 0) return 0;
  if (peak <= 1) return 4;
  const ratio = count / peak;
  if (ratio > 0.66) return 4;
  if (ratio > 0.33) return 3;
  if (ratio > 0.1) return 2;
  return 1;
}

/** One calendar year, laid out in GitHub's Sunday-to-Saturday week columns. */
export function PullRequestHeatmap({ activity }: { activity: PullRequestActivity }) {
  const cells = useMemo<Cell[]>(() => {
    const first = activity.days[0];
    if (!first) return [];
    const peak = Math.max(...activity.days.map((entry) => entry.count), 0);
    const leading = new Date(`${first.day}T00:00:00Z`).getUTCDay();
    return [
      ...Array.from({ length: leading }, (_, index) => ({ key: `empty-${index}` })),
      ...activity.days.map((entry) => ({
        key: entry.day,
        day: entry.day,
        count: entry.count,
        level: levelFor(entry.count, peak),
      })),
    ];
  }, [activity.days]);

  const label = activity.incomplete
    ? `${activity.total.toLocaleString()}+ pull requests created in the last year`
    : `${activity.total.toLocaleString()} pull requests created in the last year`;

  return (
    <section className="pr-activity-card" aria-label={label}>
      <div className="pr-activity-title-row">
        <div>
          <h2>Pull requests</h2>
          <p>Created by @{activity.login} in the last year</p>
        </div>
        <strong>{activity.total.toLocaleString()} · 1y</strong>
      </div>
      <div className="pr-activity-grid" role="img" aria-label={label}>
        {cells.map((cell) =>
          cell.day ? (
            <span
              key={cell.key}
              className="pr-activity-cell"
              data-level={cell.level}
            />
          ) : (
            <span key={cell.key} className="pr-activity-cell pr-activity-empty" aria-hidden />
          ),
        )}
      </div>
      <div className="pr-activity-legend" aria-hidden>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i key={level} className="pr-activity-cell" data-level={level} />
        ))}
        <span>More</span>
      </div>
      {activity.incomplete ? (
        <p className="pr-activity-note">Months with more than 1,000 PRs are capped by GitHub.</p>
      ) : null}
    </section>
  );
}
