/* Authentication uses browser HTTP Basic; tokens never enter localStorage or source files. */
let offset = 0;
const message = document.getElementById('message');
async function request(path, body, method = 'POST') {
  const response = await fetch(
    path,
    body
      ? {
          method,
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
      if (o.review_status === 'staged') {
        const label = document.createElement('label');
        label.textContent = 'Correct product match ';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Canonical product');
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Choose canonical product';
        select.append(empty);
        for (const p of await request('/products')) {
          const option = document.createElement('option');
          option.value = p.product_id;
          option.textContent = p.name;
          select.append(option);
        }
        label.append(select);
        card.append(label);
        const correction = document.createElement('button');
        correction.textContent = 'Save match correction';
        correction.onclick = async () => {
          try {
            await request(
              '/observations/' + o.observation_id + '/product-match',
              {
                product_id: select.value,
                reason:
                  'Reviewer confirmed canonical product from source metadata',
                idempotency_key: crypto.randomUUID(),
              },
            );
            await load();
          } catch (e) {
            message.textContent = e.message;
          }
        };
        card.append(correction);
      }
      const evidence = document.createElement('button');
      evidence.textContent = 'Derived attributes and provenance';
      evidence.onclick = () =>
        perform(async () =>
          request('/observations/' + o.observation_id + '/evidence'),
        );
      card.append(evidence);

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

const operations = document.getElementById('operations');
async function perform(action) {
  try {
    const value = await action();
    operations.textContent = JSON.stringify(value, null, 2);
    return value;
  } catch (e) {
    operations.textContent = e.message;
  }
}
const defaultSource = {
  source_id: 'operator-rss',
  name: 'Operator synthetic feed',
  type: 'rss',
  url: 'https://mock-golf.example.org/rss',
  interval_seconds: 3600,
  daily_budget: 100,
  min_request_interval_ms: 1000,
  settings: {
    allowed_hosts: ['mock-golf.example.org'],
    format: 'rss',
    channels: [],
    keywords: [],
    products: [],
    max_pages: 2,
  },
};
document.getElementById('source-json').value = JSON.stringify(
  defaultSource,
  null,
  2,
);
document.getElementById('policy-json').value = JSON.stringify(
  {
    scope: 'mock',
    permission_reference:
      'Synthetic HTTP fixtures only; no live-source collection permission',
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    metadata_days: 30,
    operations: {
      discovery: true,
      metadata: true,
      derived_insights: true,
      analyze_body: true,
      manufacturer_facts: true,
      export_analysis: true,
      export_ratings: false,
    },
  },
  null,
  2,
);
const sourceInput = () =>
  JSON.parse(document.getElementById('source-json').value);
document.getElementById('source-register').onclick = () =>
  perform(async () => {
    const result = await request('/sources', sourceInput());
    await sources();
    return result;
  });
document.getElementById('source-update').onclick = () =>
  perform(async () => {
    const input = sourceInput();
    const result = await request('/sources/' + input.source_id, input, 'PUT');
    await sources();
    return result;
  });
document.getElementById('source-policy').onclick = () =>
  perform(async () => {
    const result = await request(
      '/sources/' + sourceInput().source_id + '/policy',
      JSON.parse(document.getElementById('policy-json').value),
    );
    await sources();
    return result;
  });
function button(label, action) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => perform(action);
  return b;
}
async function sources() {
  const list = await request('/sources');
  const container = document.getElementById('sources');
  container.replaceChildren();
  for (const s of list) {
    const row = document.createElement('article');
    const p = document.createElement('p');
    p.textContent = `${s.name} (${s.source_id}) — ${s.type}; enabled for mock: ${s.enabled}; live enabled: ${s.live_authorized}; policy: ${s.status}, ${s.scope}, expires ${s.expires_at}; quota ${s.quota_used}/${s.daily_budget}; last success ${s.last_success_at ?? 'never'}; error ${s.last_error_code ?? 'none'}; next ${s.next_collection_at ?? 'unset'}`;
    row.append(p);
    if (!s.type.startsWith('fixture-')) {
      row.append(
        button('Authorize mock source', async () => {
          const r = await request(
            '/sources/' + s.source_id + '/enable-mock',
            {},
          );
          await sources();
          return r;
        }),
      );
      row.append(
        button('Collect synthetic HTTP profile', async () => {
          const r = await request('/sources/' + s.source_id + '/collect-mock', {
            idempotency_key: crypto.randomUUID(),
          });
          await sources();
          await load();
          return r;
        }),
      );
      row.append(
        button('Inspect configuration', async () => {
          const r = await request('/sources/' + s.source_id);
          document.getElementById('source-json').value = JSON.stringify(
            r,
            null,
            2,
          );
          return r;
        }),
      );
    }
    row.append(
      button('Suspend and suppress evidence', async () => {
        const r = await request('/sources/' + s.source_id + '/disable', {});
        await sources();
        await load();
        return r;
      }),
    );
    row.append(
      button('Policy and error history', () =>
        request('/sources/' + s.source_id + '/events'),
      ),
    );
    container.append(row);
  }
}
async function jobs() {
  const list = await request('/jobs?limit=25');
  const container = document.getElementById('jobs');
  container.replaceChildren();
  for (const j of list) {
    const row = document.createElement('p');
    row.textContent = `${j.source_id}: ${j.state}; attempt ${j.attempts}; error ${j.error_code ?? 'none'}; retry ${j.next_retry_at}`;
    if (j.state === 'retry' && !j.source_id.startsWith('fixture-'))
      row.append(
        button('Retry when due (mock)', async () => {
          const r = await request('/sources/' + j.source_id + '/collect-mock', {
            idempotency_key: j.run_key,
          });
          await jobs();
          return r;
        }),
      );
    container.append(row);
  }
}
async function facts() {
  const list = await request('/facts');
  const container = document.getElementById('facts');
  container.replaceChildren();
  for (const f of list) {
    const row = document.createElement('article');
    const p = document.createElement('p');
    p.textContent = JSON.stringify({
      id: f.fact_id,
      source: f.source_id,
      model: f.model,
      variant: f.variant,
      status: f.review_status,
      specifications: f.specifications,
    });
    row.append(p);
    for (const action of f.review_status === 'staged'
      ? ['approve', 'reject']
      : f.review_status === 'approved_for_analysis'
        ? ['revoke']
        : [])
      row.append(
        button(action + ' fact for analysis', async () => {
          const r = await request('/facts/' + f.fact_id + '/decision', {
            action,
          });
          await facts();
          return r;
        }),
      );
    container.append(row);
  }
}
document.getElementById('sources-refresh').onclick = () => perform(sources);
document.getElementById('jobs-refresh').onclick = () => perform(jobs);
document.getElementById('facts-refresh').onclick = () => perform(facts);
document.getElementById('preview').onclick = () =>
  perform(() => request('/exports/preview', { type: 'analysis_observations' }));
document.getElementById('export-history').onclick = () =>
  perform(() => request('/exports/history'));
document.getElementById('purge').onclick = () =>
  perform(() => request('/retention/purge', {}));
void perform(sources);
