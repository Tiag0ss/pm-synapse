export type PlannerLinkItem = {
  markerId: string | null;
  openUrl: string | null;
  pmTaskId?: number | null;
};

/**
 * Attach “Open in Planner” links next to markdown checkboxes that have a PM task.
 * Markers come from `<span class="synapse-cb-marker" data-marker-id="…">` in rendered HTML.
 */
export function applyPlannerButtons(root: HTMLElement, items: PlannerLinkItem[]): void {
  root.querySelectorAll('a.synapse-open-planner').forEach((el) => el.remove());

  const byMarker = new Map<string, PlannerLinkItem>();
  for (const item of items) {
    if (item.markerId && item.openUrl) byMarker.set(item.markerId, item);
  }
  if (!byMarker.size) return;

  root.querySelectorAll<HTMLElement>('.synapse-cb-marker[data-marker-id]').forEach((marker) => {
    const id = marker.getAttribute('data-marker-id');
    if (!id) return;
    const link = byMarker.get(id);
    if (!link?.openUrl) return;

    const li = marker.closest('li');
    if (!li) return;
    if (li.querySelector('a.synapse-open-planner')) return;

    const a = document.createElement('a');
    a.className = 'synapse-open-planner';
    a.href = link.openUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.title = link.pmTaskId ? `Open task #${link.pmTaskId} in Project Management` : 'Open in Project Management';
    a.textContent = link.pmTaskId ? `Planner #${link.pmTaskId}` : 'Open in Planner';
    li.appendChild(document.createTextNode(' '));
    li.appendChild(a);
  });
}
