/* Authentication uses browser HTTP Basic; tokens never enter localStorage or source files. */
let offset = 0;
const message = document.getElementById('message');
async function request(path, body) {
  const response = await fetch(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-TPR-Review': '1' },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request rejected');
  return data;
}
async function load() {
  try {
    const data = await request(
      '/observations?status=' +
        document.getElementById('status').value +
        '&limit=25&offset=' +
        offset,
    );
    const queue = document.getElementById('queue');
    queue.replaceChildren();
    for (const o of data.items) {
      const card = document.createElement('article');
      const title = document.createElement('h2');
      title.textContent = o.product_match.candidate_label;
      card.append(title);
      const summary = document.createElement('p');
      summary.textContent = `${o.observation_kind} · ${o.sentiment} · ${o.topic ?? 'unknown topic'} · rating: ${o.explicit_rating?.value ?? 'unknown'} · player type: ${o.player_type ?? 'unknown'} · flags: ${o.quality_flags.join(', ') || 'none'} · policy: ${o.rights_policy_id}`;
      card.append(summary);
      const link = document.createElement('a');
      link.href = o.source_url;
      link.textContent = 'Synthetic source attribution';
      link.rel = 'noreferrer';
      card.append(link);
      const reason = document.createElement('select');
      reason.setAttribute('aria-label', 'Decision reason');
      for (const value of [
        'verified_fixture',
        'insufficient_evidence',
        'ambiguous_product',
        'rights_concern',
        'sponsored',
        'duplicate',
        'takedown',
        'correction',
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        reason.append(option);
      }
      card.append(reason);
      const actions =
        o.review_status === 'staged'
          ? ['approve', 'reject']
          : o.review_status === 'approved_for_analysis'
            ? ['revoke']
            : [];
      for (const action of actions) {
        const button = document.createElement('button');
        button.textContent =
          action === 'approve' ? 'Approve for analysis' : action;
        button.onclick = async () => {
          try {
            await request('/observations/' + o.observation_id + '/decision', {
              action,
              reason: reason.value,
              idempotency_key: crypto.randomUUID(),
            });
            await load();
          } catch (e) {
            message.textContent = e.message;
          }
        };
        card.append(button);
      }
      const history = document.createElement('button');
      history.textContent = 'Review history';
      history.onclick = async () => {
        try {
          message.textContent = JSON.stringify(
            await request('/observations/' + o.observation_id + '/history'),
          );
        } catch (e) {
          message.textContent = e.message;
        }
      };
      card.append(history);
      queue.append(card);
    }
    message.textContent = `Showing ${data.items.length} observations, offset ${offset}.`;
  } catch (e) {
    message.textContent = e.message;
  }
}
document.getElementById('refresh').onclick = () => {
  offset = 0;
  void load();
};
document.getElementById('previous').onclick = () => {
  offset = Math.max(0, offset - 25);
  void load();
};
document.getElementById('next').onclick = () => {
  offset += 25;
  void load();
};
document.getElementById('export').onclick = async () => {
  try {
    const result = await request('/exports/generate', {
      authorize_local_export: true,
      type: 'analysis_observations',
    });
    message.textContent = JSON.stringify(result);
  } catch (e) {
    message.textContent = e.message;
  }
};
void load();
