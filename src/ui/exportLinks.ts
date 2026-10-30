import { AppEvents, locationUtil, RawTimeRange, toURLRange, urlUtil } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';

import { CompiledPlan } from '../compile';

/** Every query that runs, as `a: <expr>` lines. */
export function promqlText(plan: CompiledPlan | undefined): string {
  return (plan?.queries ?? [])
    .filter((q) => !q.skip && q.expr !== '')
    .map((q) => `${q.letter}: ${q.expr}`)
    .join('\n');
}

/** Grafana Explore with the compiled queries on the datasource and the dashboard's time range. */
export function exploreUrl(
  plan: CompiledPlan | undefined,
  datasourceUid: string,
  range: RawTimeRange
): string | undefined {
  const datasource = { type: 'prometheus', uid: datasourceUid };
  const queries = (plan?.queries ?? [])
    .filter((q) => !q.skip && q.expr !== '')
    .map((q) => ({
      refId: q.letter.toUpperCase(),
      datasource,
      expr: q.expr,
      range: true,
      instant: false,
      interval: `${q.stepSec}s`,
      legendFormat: '__auto',
      editorMode: 'code',
    }));
  if (queries.length === 0) {
    return undefined;
  }
  const panes = { mx: { datasource: datasourceUid, queries, range: toURLRange(range) } };
  return locationUtil.assureBaseUrl(urlUtil.renderUrl('/explore', { schemaVersion: 1, panes: JSON.stringify(panes) }));
}

export async function copyToClipboard(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify(AppEvents.alertSuccess.name, `${what} copied to the clipboard`);
  } catch {
    notify(AppEvents.alertError.name, `${what} could not be copied`);
  }
}

function notify(type: string, text: string) {
  getAppEvents().publish({ type, payload: [text] });
}
